// Tests read JSON bodies loosely; lib.dom types Response.json() as unknown.
export {};
declare global {
  interface Response {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(): Promise<any>;
  }
}
