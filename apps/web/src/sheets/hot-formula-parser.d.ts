declare module "hot-formula-parser" {
  interface ParserCoord {
    row: { index: number };
    column: { index: number };
  }
  export class Parser {
    parse(formula: string): { error: string | null; result: unknown };
    on(event: "callCellValue", cb: (coord: ParserCoord, done: (v: unknown) => void) => void): void;
    on(event: "callRangeValue", cb: (start: ParserCoord, end: ParserCoord, done: (v: unknown) => void) => void): void;
    on(event: string, cb: (...args: never[]) => void): void;
  }
}
