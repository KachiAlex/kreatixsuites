declare module "hot-formula-parser" {
  interface ParserCoord {
    row: { index: number };
    column: { index: number };
  }
  export class Parser {
    parse(formula: string): { error: string | null; result: unknown };
    setFunction(name: string, fn: (params: unknown[]) => unknown): void;
    getFunction(name: string): ((params: unknown[]) => unknown) | undefined;
    on(event: "callCellValue", cb: (coord: ParserCoord, done: (v: unknown) => void) => void): void;
    on(event: "callRangeValue", cb: (start: ParserCoord, end: ParserCoord, done: (v: unknown) => void) => void): void;
    on(event: string, cb: (...args: never[]) => void): void;
  }
  /** The function-name table the parser registers. */
  export const SUPPORTED_FORMULAS: string[];
}
