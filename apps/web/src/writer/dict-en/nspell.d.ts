// Minimal typings for nspell@2 — upstream ships no declarations.
declare module "nspell" {
  export interface Spell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    add(word: string, model?: string): void;
    remove(word: string): void;
    forbidden(word: string): boolean;
    personal(word: string): void;
    wordCharacters(): string | undefined;
    dictionary(): Uint8Array;
  }
  export default function nspell(
    aff: string | Uint8Array,
    dic: string | Uint8Array | readonly (string | Uint8Array)[],
  ): Spell;
}
