export type Kind = "meat" | "vegetable" | "other";
export type User = { id: number; username: string; is_admin: boolean };
export type Dish = {
  id: number;
  owner_id: number;
  owner_name: string;
  name: string;
  category: string;
  kind: Kind;
  image_url: string;
  ingredients: string;
  notes: string;
  is_example: boolean;
  version: number;
};
export type Item = {
  dish_id: number;
  source_user: string;
  name: string;
  ingredients: string;
  image_url: string;
  kind: Kind;
};
export type RecordEntry = {
  id: number;
  owner_id: number;
  owner_name: string;
  date: string;
  version: number;
  items: Item[];
};
export type Stat = {
  owner_id: number;
  dish_id: number;
  source_user: string;
  name: string;
  count: number;
  last_date: string;
};
