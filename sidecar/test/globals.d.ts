// Tests read JSON bodies loosely.
interface Response {
  json(): Promise<any>;
}
interface Request {
  json(): Promise<any>;
}
