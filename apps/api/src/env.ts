export type Env = {
  DATABASE_URL: string;
  ENV?: "preview" | "staging" | "production";
};
