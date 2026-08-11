export interface Section {
  id: number;
  name: string;
  collapsed: boolean;
}

export interface Item {
  id: number;
  sectionId: number | null;
  content: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AppState {
  sections: Section[];
  items: Item[];
  activeSectionId: number | null;
  theme: string;
}
