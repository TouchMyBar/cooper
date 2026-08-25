//! Double-shift listener for macOS, built on a listen-only `CGEventTap`.
//!
//! rdev is unusable here: it decodes characters off the main thread via the
//! keyboard-layout APIs (`TISCopyCurrentKeyboardInputSource`/`UCKeyTranslate`),
//! which aren't thread-safe, and dies with SIGTRAP inside HIToolbox. Telling the
//! two Shift keys apart needs only the modifier flag bits, so this tap never
//! touches those APIs and never decodes anything.
//!
//! The tap needs the Accessibility permission, which on macOS 12 covers both
//! receiving keys and injecting the copy chord — one checkbox, no relaunch. An
//! unauthorised tap does *not* fail loudly, so viability is judged by
//! `CGEventTapIsEnabled` rather than by getting a handle back; see `run_tap`.
//! We keep retrying, so ticking the box while Cooper is running starts the
//! listener, and `is_running()` lets the UI show setup help until it does.

use std::cell::RefCell;
use std::ffi::c_void;
use std::os::raw::c_uchar;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use core_foundation::base::TCFType;
use core_foundation::mach_port::CFMachPortRef;
use core_foundation::runloop::{kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFRunLoop};
use core_graphics::event::{
    CGEvent, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventTapProxy, CGEventType, CallbackResult,
};
use tauri::AppHandle;

use crate::capture::{self, Side, HOLD_LIMIT, TAP_WINDOW};
use crate::panel;

/// Device-dependent modifier bits from IOLLEvent.h. The device-*independent*
/// `CGEventFlagShift` bit is set for either Shift, so it can't tell them apart.
const NX_DEVICELSHIFTKEYMASK: u64 = 0x0000_0002;
const NX_DEVICERSHIFTKEYMASK: u64 = 0x0000_0004;
const SHIFT_BITS: u64 = NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK;

/// The device-*independent* Shift bit, which macOS sets alongside whichever
/// device-dependent bit above is involved.
const NX_SHIFTMASK: u64 = 0x0002_0000;
/// Set on essentially every event and carrying no modifier meaning.
const NX_NONCOALESCEDMASK: u64 = 0x2000_0000;
/// Bits that move as a side effect of a plain Shift tap, so a change in them
/// must not be mistaken for "some other modifier was pressed".
///
/// Verified against a live tap on macOS 12: Left Shift reports 0x20020002,
/// Right Shift 0x20020004, a Command press 0x20100008, and every release
/// 0x20000000. Without this mask the companion bits mark every Shift tap as a
/// chord and no double-tap ever fires.
const COMPANION_BITS: u64 = SHIFT_BITS | NX_SHIFTMASK | NX_NONCOALESCEDMASK;

/// How long to wait before re-attempting a tap that was refused for lack of
/// permission.
const RETRY_DELAY: Duration = Duration::from_secs(3);
/// How often a live tap is checked for having been switched off underneath us.
const HEALTH_INTERVAL: Duration = Duration::from_secs(2);

// `CGEvent.h` declares these as C `bool`, so Rust `bool` is ABI-correct here.
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventTapIsEnabled(tap: CFMachPortRef) -> bool;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGPreflightPostEventAccess() -> bool;
}

// `AXIsProcessTrusted` returns a `Boolean`, which is `unsigned char` and not
// C's `_Bool`, so it must not be declared as Rust `bool`.
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> c_uchar;
}

static TAP_RUNNING: AtomicBool = AtomicBool::new(false);

/// Whether the event tap is live. False means the double-shift shortcuts are
/// inert and the user needs to grant Accessibility.
pub fn is_running() -> bool {
    TAP_RUNNING.load(Ordering::Relaxed)
}

/// Whether Cooper holds the Accessibility permission.
///
/// Calling this also has a useful side effect: it makes macOS create Cooper's
/// row in the Accessibility list, so the user can simply tick a checkbox
/// instead of hunting for the app with the "+" button.
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Whether the tap is allowed to receive keys and Cooper is allowed to inject
/// the copy chord. On macOS 12 a single Accessibility grant satisfies both;
/// neither call prompts, so this is safe to poll.
fn has_permission() -> bool {
    unsafe { CGPreflightListenEventAccess() && CGPreflightPostEventAccess() }
}

struct State {
    prev_flags: u64,
    /// The Shift currently held, and when it went down.
    pressed: Option<(Side, Instant)>,
    /// A non-Shift key moved while Shift was held, so this isn't a bare tap.
    dirty: bool,
    /// The last completed bare tap, for double-tap detection.
    last_tap: Option<(Side, Instant)>,
}

enum Action {
    None,
    Capture,
    Toggle,
}

/// Mirrors the rdev state machine in `capture.rs`, but driven by flag-bit edges
/// rather than key events, so holding both Shifts resolves correctly and the
/// state resynchronises if an event is ever missed.
/// `now` is passed in rather than read inside so the timing rules are testable.
fn on_flags_changed(state: &RefCell<State>, flags: u64, now: Instant) -> Action {
    let mut s = state.borrow_mut();
    let changed = flags ^ s.prev_flags;
    s.prev_flags = flags;

    // Any other modifier moving means this was a chord, not a bare Shift tap.
    if changed & !COMPANION_BITS != 0 {
        s.dirty = true;
        s.last_tap = None;
    }

    let mut action = Action::None;
    for &(bit, side) in &[
        (NX_DEVICELSHIFTKEYMASK, Side::Left),
        (NX_DEVICERSHIFTKEYMASK, Side::Right),
    ] {
        if changed & bit == 0 {
            continue;
        }
        if flags & bit != 0 {
            if s.pressed.is_none() {
                s.pressed = Some((side, now));
                s.dirty = false;
            }
            continue;
        }
        let tapped = match s.pressed {
            Some((p, at)) => {
                p == side && !s.dirty && now.saturating_duration_since(at) < HOLD_LIMIT
            }
            None => false,
        };
        s.pressed = None;
        if !tapped {
            s.last_tap = None;
            continue;
        }
        let is_double = matches!(
            s.last_tap,
            Some((prev, at)) if prev == side && now.saturating_duration_since(at) < TAP_WINDOW
        );
        if is_double {
            s.last_tap = None;
            action = match side {
                Side::Left => Action::Capture,
                Side::Right => Action::Toggle,
            };
        } else {
            s.last_tap = Some((side, now));
        }
    }
    action
}

/// Run a tap on this thread until it stops being viable, then return why.
///
/// A tap must never be trusted just because it was created. With `ListenOnly`,
/// an unauthorised `CGEventTapCreate` still hands back a non-null port with the
/// KeyDown bit quietly stripped from its mask, permanently disabled and unable
/// to be re-enabled. Only `CGEventTapIsEnabled` distinguishes a live tap from
/// that corpse, so it is checked after arming and then periodically, which also
/// catches the permission being revoked while Cooper runs.
fn run_tap(app: &AppHandle) -> Result<(), &'static str> {
    if !has_permission() {
        return Err("Accessibility not granted");
    }
    let state = RefCell::new(State {
        prev_flags: 0,
        pressed: None,
        dirty: false,
        last_tap: None,
    });
    let port: Arc<AtomicPtr<c_void>> = Arc::new(AtomicPtr::new(ptr::null_mut()));
    let port_cb = Arc::clone(&port);
    let app_cb = app.clone();

    let tap = CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
        move |_proxy: CGEventTapProxy, etype: CGEventType, event: &CGEvent| {
            match etype {
                // The system can switch a tap off; turn it back on or the
                // shortcuts would silently stop working until relaunch.
                CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                    let p = port_cb.load(Ordering::Relaxed);
                    if !p.is_null() {
                        unsafe { CGEventTapEnable(p as CFMachPortRef, true) };
                    }
                }
                CGEventType::KeyDown => {
                    let mut s = state.borrow_mut();
                    s.dirty = true;
                    s.last_tap = None;
                }
                CGEventType::FlagsChanged => {
                    match on_flags_changed(&state, event.get_flags().bits(), Instant::now()) {
                        Action::Capture => capture::capture_selection(&app_cb),
                        Action::Toggle => panel::toggle(&app_cb),
                        Action::None => {}
                    }
                }
                _ => {}
            }
            CallbackResult::Keep
        },
    )
    .map_err(|()| "could not create the event tap")?;

    let port_ref = tap.mach_port().as_concrete_TypeRef();
    port.store(port_ref as *mut c_void, Ordering::Relaxed);
    let source = tap
        .mach_port()
        .create_runloop_source(0)
        .map_err(|()| "could not attach the tap to a run loop")?;
    CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopCommonModes });
    tap.enable();

    if !unsafe { CGEventTapIsEnabled(port_ref) } {
        return Err("the event tap was created but refused to arm");
    }

    TAP_RUNNING.store(true, Ordering::Relaxed);
    // Run in slices rather than blocking forever, so a revoked permission is
    // noticed and the outer loop can build a fresh tap.
    while unsafe { CGEventTapIsEnabled(port_ref) } {
        CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, HEALTH_INTERVAL, false);
    }
    TAP_RUNNING.store(false, Ordering::Relaxed);
    Err("the event tap was switched off")
}

#[cfg(test)]
mod tests {
    use super::*;

    const L: u64 = NX_DEVICELSHIFTKEYMASK;
    const R: u64 = NX_DEVICERSHIFTKEYMASK;

    fn state() -> RefCell<State> {
        RefCell::new(State {
            prev_flags: 0,
            pressed: None,
            dirty: false,
            last_tap: None,
        })
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// The flag word macOS actually reports when `held` Shift bits are down,
    /// companion bits included. Tests must use this rather than bare side bits,
    /// or they pass against flags the OS never emits.
    fn flags(held: u64) -> u64 {
        if held == 0 {
            NX_NONCOALESCEDMASK
        } else {
            held | NX_SHIFTMASK | NX_NONCOALESCEDMASK
        }
    }

    /// Feed a sequence of (Shift bits held, milliseconds) and return the last
    /// action produced.
    fn feed(st: &RefCell<State>, base: Instant, steps: &[(u64, u64)]) -> Action {
        feed_raw(
            st,
            base,
            &steps
                .iter()
                .map(|&(held, at)| (flags(held), at))
                .collect::<Vec<_>>(),
        )
    }

    /// Feed literal flag words, for sequences captured from a live tap.
    fn feed_raw(st: &RefCell<State>, base: Instant, steps: &[(u64, u64)]) -> Action {
        let mut last = Action::None;
        for &(bits, at) in steps {
            last = on_flags_changed(st, bits, base + ms(at));
        }
        last
    }

    #[test]
    fn left_double_tap_captures() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(L, 0), (0, 50), (L, 100), (0, 150)]);
        assert!(matches!(a, Action::Capture));
    }

    #[test]
    fn right_double_tap_toggles() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(R, 0), (0, 50), (R, 100), (0, 150)]);
        assert!(matches!(a, Action::Toggle));
    }

    #[test]
    fn single_tap_does_nothing() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(L, 0), (0, 50)]);
        assert!(matches!(a, Action::None));
    }

    #[test]
    fn second_tap_after_the_window_does_not_fire() {
        let (st, t0) = (state(), Instant::now());
        // Second release lands 450ms after the first, past TAP_WINDOW (400ms).
        let a = feed(&st, t0, &[(L, 0), (0, 50), (L, 100), (0, 500)]);
        assert!(matches!(a, Action::None));
    }

    #[test]
    fn holding_shift_too_long_is_not_a_tap() {
        let (st, t0) = (state(), Instant::now());
        // Each press is held past HOLD_LIMIT (500ms), so neither counts.
        let a = feed(&st, t0, &[(L, 0), (0, 600), (L, 700), (0, 1300)]);
        assert!(matches!(a, Action::None));
    }

    #[test]
    fn shift_used_as_a_modifier_is_not_a_tap() {
        let (st, t0) = (state(), Instant::now());
        // Real Cmd-Shift chord: Cmd adds 0x8 and 0x100000 on top of Shift.
        let a = feed_raw(
            &st,
            t0,
            &[
                (0x2002_0002, 0),  // L-Shift down
                (0x2012_000A, 10), // Cmd down while Shift held
                (0x2002_0002, 20), // Cmd up
                (0x2000_0000, 30), // Shift up
                (0x2002_0002, 60), // a following tap must not complete a pair
                (0x2000_0000, 90),
            ],
        );
        assert!(matches!(a, Action::None));
    }

    /// Regression tests built from bits a live macOS 12 tap actually emitted.
    /// These fail if the companion-bit mask is ever dropped.
    #[test]
    fn captured_left_double_tap_captures() {
        let (st, t0) = (state(), Instant::now());
        let a = feed_raw(
            &st,
            t0,
            &[
                (0x2002_0002, 0),
                (0x2000_0000, 50),
                (0x2002_0002, 100),
                (0x2000_0000, 150),
            ],
        );
        assert!(matches!(a, Action::Capture));
    }

    #[test]
    fn captured_right_double_tap_toggles() {
        let (st, t0) = (state(), Instant::now());
        let a = feed_raw(
            &st,
            t0,
            &[
                (0x2002_0004, 0),
                (0x2000_0000, 50),
                (0x2002_0004, 100),
                (0x2000_0000, 150),
            ],
        );
        assert!(matches!(a, Action::Toggle));
    }

    #[test]
    fn the_two_sides_do_not_combine() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(L, 0), (0, 50), (R, 100), (0, 150)]);
        assert!(matches!(a, Action::None));
    }

    #[test]
    fn holding_both_shifts_fires_nothing() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(L, 0), (L | R, 20), (R, 40), (0, 60)]);
        assert!(matches!(a, Action::None));
    }

    #[test]
    fn a_third_tap_starts_a_fresh_pair() {
        let (st, t0) = (state(), Instant::now());
        // Two taps fire, and the third must not immediately fire again.
        let a = feed(
            &st,
            t0,
            &[(L, 0), (0, 50), (L, 100), (0, 150), (L, 200), (0, 250)],
        );
        assert!(matches!(a, Action::None));
    }
}

/// Start the listener on its own thread. Never fails loudly: if the permission
/// is missing we keep retrying, and the fallback hotkeys work regardless.
pub fn start(app: AppHandle) {
    // Asking once, even though the answer is ignored here, is what makes macOS
    // list Cooper under Accessibility — so the setup guide can say "tick the
    // box" rather than "find the app with the + button".
    let _ = is_trusted();
    std::thread::spawn(move || {
        let mut reported: Option<&'static str> = None;
        loop {
            if let Err(reason) = run_tap(&app) {
                // Only speak up when the reason changes, or a denied tap would
                // print every few seconds forever.
                if reported != Some(reason) {
                    reported = Some(reason);
                    eprintln!(
                        "cooper: double-shift inactive — {reason}; fallback hotkeys still work"
                    );
                }
            }
            std::thread::sleep(RETRY_DELAY);
        }
    });
}
