import type { Lang, Rule, SgNode } from '@ast-grep/napi'

/** An ast-grep language: a bundled `Lang` or the name a dynamic language is registered under. */
export type ParserName = Lang | (string & {})

/** An ast-grep relational rule (`inside`, `has`, ...), which may also name a `field` and `stopBy`. */
export type Relation = NonNullable<Rule['inside']>

/** A parsed source file as language rules see it. */
export interface SourceFile {
  /** Relative to the analyzed directory, with `/` separators. */
  path: string
  /** The ast-grep language the file was parsed with. */
  parser: ParserName
  text: string
  root: SgNode
}

/**
 * Where a rename of a name stays correct: `module` renames every reference in the file,
 * `local` every reference in the enclosing function, `none` means the name is visible outside
 * the file (exported, package-scoped, a member) and is reported without a suggested rename.
 */
export type RenameScope = 'module' | 'local' | 'none'

/** One kind of declared name, e.g. module-level constants in TypeScript. */
export interface NameKind {
  /** Kebab-case id; the issue rule is `naming/<id>`. */
  id: string
  /** Human label reported as `ConventionStat.kind`, e.g. `module constant`. */
  label: string
  /** ast-grep rule matching the identifier node of each declared name of this kind. */
  rule: Rule
  /** Further filter for what a rule cannot express, e.g. "the initializer is a literal". */
  when?: (name: SgNode, file: SourceFile) => boolean
  /** Default `module`; a `module` name the language reports as public falls back to `none`. */
  scope?: RenameScope
}

/** How a node with the renamed text is treated when renaming a binding. */
export type ReferenceAction =
  /** A reference to the binding: replace the node's text. */
  | 'rename'
  /** Not a reference (a property key, a member access): leave it alone. */
  | 'skip'
  /** Cannot be renamed safely (shorthand destructuring, ambiguous keys): drop the whole rename. */
  | 'abort'
  /** A reference that needs a different replacement, e.g. `{ foo }` → `{ foo: FOO }`. */
  | { text: string }

/**
 * Everything the conventions engine needs to know about one language. Adding a language means
 * adding one module that exports a `LanguageSpec` and listing it in `languages/index.ts`.
 */
export interface LanguageSpec {
  /** Reported as `ConventionStat.language`. */
  id: string
  /** File extensions without the dot. */
  extensions: readonly string[]
  /** ast-grep language used to parse a file with one of `extensions`. */
  parser(path: string): ParserName
  /**
   * For languages ast-grep does not bundle: loads the `@ast-grep/lang-*` registration, which is
   * registered under the name `parser` returns.
   */
  dynamic?: () => Promise<DynamicLanguage>
  /** Checked in order; a name node belongs to the first kind that matches it. */
  kinds: readonly NameKind[]
  /** Node kinds whose text is an identifier that may refer to a binding. */
  identifiers: readonly string[]
  /** Node kinds that open a function scope for `local` names. */
  functionScopes: readonly string[]
  /** Whether a `module` name is visible outside its file, e.g. exported. */
  isPublic(name: SgNode, file: SourceFile): boolean
  /** How an identifier node with the old name is treated; default `rename`. */
  reference?(node: SgNode, newName: string): ReferenceAction
  /** Whether `scope` refers to the name in ways the tree does not show, e.g. Rust `"{name}"`. */
  hiddenReferences?(scope: SgNode, name: string): boolean
  /** Kind of a file's name; default `file name`, `undefined` skips the file. */
  fileNameKind?(path: string): string | undefined
}

/** What an `@ast-grep/lang-*` package exports. */
export interface DynamicLanguage {
  libraryPath: string
  extensions: string[]
  languageSymbol?: string
  metaVarChar?: string
  expandoChar?: string
}
