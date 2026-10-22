/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {inspectUpdateRoots} from '@lexical/y/server';
import {applyUpdate, Doc, encodeStateAsUpdate, mergeUpdates} from '@y/y';
import {
  $getRoot,
  type AnyLexicalExtensionArgument,
  type CreateEditorArgs,
  defineExtension,
  type LexicalEditor,
  type LexicalEditorWithDispose,
} from 'lexical';

import {type ClientIDRange, DEFAULT_ROOT_NAME, YBinding} from '.';

/**
 * @experimental The editor a headless helper binds: the same extensions (or
 * nodes) as the clients' editors, so that the server reads and writes the
 * document the way a client would.
 */
export interface HeadlessYConfig {
  /** Extensions that define the editor: nodes, transforms, NodeState. */
  extensions?: readonly AnyLexicalExtensionArgument[];
  /** Node classes, for an editor that is not defined by extensions. */
  nodes?: CreateEditorArgs['nodes'];
  /** The name of the shared root (default `'lexical-y'`). */
  root?: string;
  /**
   * The range of the client ids the server writes with (default
   * `'uint53'`). Use `'uint32'` when updates pass through yrs before 0.28.
   */
  clientIDRange?: ClientIDRange;
  /**
   * Called with the binding's and the editor's warnings (a write that had to
   * be recovered, a self-check mismatch, the reason a document is read only;
   * it replaces an `onWarn` of the extensions). Warnings never refuse an
   * edit, in any environment. Default: `console.warn` outside production,
   * nothing in production.
   */
  onWarn?: (message: string) => void;
  /**
   * The binding's self-check of its own writes (see `YBindingOptions`).
   * Default: on in development, off in production.
   */
  selfCheck?: boolean;
}

/** @experimental */
export interface CreateHeadlessYEditorOptions extends HeadlessYConfig {
  /** A Yjs update (usually the stored state) to load before binding. */
  state?: Uint8Array | null;
}

/**
 * @experimental A headless editor bound to its own Yjs 14 document, with
 * collaborative undo off. `dispose` (or `using`) releases the binding, the
 * editor and the document.
 */
export interface HeadlessYEditor extends Disposable {
  readonly editor: LexicalEditor;
  readonly doc: Doc;
  readonly binding: YBinding;
  /** Warnings the binding reported, oldest first. */
  readonly warnings: readonly string[];
  dispose(): void;
}

/** @experimental */
export type YHeadlessErrorCode =
  /** The state has no layout record yet: seed it first. */
  | 'not-initialized'
  /**
   * The binding is read only: the document uses a newer layout, content
   * without a layout record, or node types the editor does not register.
   */
  | 'read-only'
  /** The update writes to a root that is not allowed, or cannot be resolved. */
  | 'foreign-roots';

/** @experimental The error the headless helpers throw when they refuse. */
export class YHeadlessError extends Error {
  readonly code: YHeadlessErrorCode;
  constructor(code: YHeadlessErrorCode, message: string) {
    super(message);
    this.name = 'YHeadlessError';
    this.code = code;
  }
}

/** @experimental The result of {@link editYState}. */
export interface EditYStateResult {
  /**
   * Everything the edit wrote, as one merged update, or null when it changed
   * nothing. Includes what opening the document wrote (repairs and
   * refreshes a client would also write), which the edit may depend on.
   */
  update: Uint8Array | null;
  /** `state` with `update` merged in. */
  state: Uint8Array;
  /** Warnings the binding reported while opening and editing. */
  warnings: string[];
}

/** @experimental */
export interface EditYStateOptions {
  /**
   * The shared roots the update may write to; anything else refuses the
   * edit. Default: the layout root only.
   */
  allowedRoots?: Iterable<string>;
  /**
   * Writes to other shared types of the document (for example an activity
   * log), run in one Yjs transaction after the edit. Their roots must be in
   * `allowedRoots`.
   */
  transact?: (doc: Doc) => void;
  /** Update tag(s) of the edit's editor update. */
  tag?: string | string[];
}

/** Follow-up updates committed after an edit before giving up on them. */
const MAX_FOLLOW_UPS = 8;

interface Opened {
  readonly handle: HeadlessYEditor;
  /** Updates written since `state` was loaded (only when recording). */
  readonly writes: Uint8Array<ArrayBuffer>[];
  /** Run `$fn` in one discrete update; rethrow its error after the update. */
  runUpdate(fn: () => void, tag?: string | string[]): void;
}

function open(options: CreateHeadlessYEditorOptions, record = false): Opened {
  // While an internal update runs, errors are collected and rethrown after
  // it, so Lexical restores the previous state (nothing is written).
  let captured: Error[] | null = null;
  const onError = (error: Error) => {
    if (captured === null) {
      throw error;
    }
    captured.push(error);
  };
  // The binding reports some warnings through its own option (why a
  // document is read only) and others through the editor (a recovered
  // write, a self-check mismatch): both are collected and reported here.
  const warnings: string[] = [];
  const onWarn = options.onWarn;
  const report = (message: string) => {
    warnings.push(message);
    if (onWarn) {
      onWarn(message);
    } else if (process.env.NODE_ENV !== 'production') {
      console.warn(message);
    }
  };
  const editor: LexicalEditorWithDispose = buildEditorFromExtensions(
    defineExtension({
      dependencies: options.extensions ? [...options.extensions] : [],
      name: '@lexical/y/headless',
      nodes: options.nodes,
      onError,
      onWarn: (error: Error) => report(error.message),
    }),
  );
  // No garbage collection: the root check resolves deleted items. The
  // binding keeps the client id in range (`clientIDRange`) from `start()`;
  // nothing is written before that.
  const doc = new Doc({gc: false});
  if (options.state) {
    applyUpdate(doc, options.state);
  }
  const writes: Uint8Array<ArrayBuffer>[] = [];
  const collect = (update: Uint8Array) => {
    writes.push(new Uint8Array(update));
  };
  if (record) {
    doc.on('update', collect);
  }
  const binding = new YBinding(editor, doc, {
    captureTimeout: null,
    clientIDRange: options.clientIDRange,
    onWarn: report,
    root: doc.get(options.root || DEFAULT_ROOT_NAME),
    selfCheck: options.selfCheck,
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    doc.off('update', collect);
    binding.dispose();
    editor.dispose();
    doc.destroy();
  };
  const runUpdate = (fn: () => void, tag?: string | string[]) => {
    const errors: Error[] = [];
    captured = errors;
    try {
      editor.update(fn, {discrete: true, tag});
    } finally {
      captured = null;
    }
    if (errors.length > 0) {
      throw errors[0];
    }
    // Commit the updates this one made listeners schedule (an extension that
    // gives new blocks ids, the binding's refreshes), so that what they write
    // is part of this edit rather than lost when the editor is disposed.
    for (
      let i = 0;
      i < MAX_FOLLOW_UPS &&
      (editor._pendingEditorState !== null || editor._updates.length > 0);
      i++
    ) {
      runUpdate(() => {}, tag);
    }
  };
  try {
    binding.start();
    // Commit any update the first read scheduled (refreshes, repairs).
    runUpdate(() => {});
  } catch (error) {
    dispose();
    throw error;
  }
  if (binding.status === 'readonly') {
    dispose();
    throw new YHeadlessError(
      'read-only',
      `@lexical/y: the document is read only here${
        warnings.length > 0 ? ': ' + warnings.join(' ') : '.'
      }`,
    );
  }
  return {
    handle: {
      binding,
      dispose,
      doc,
      editor,
      [Symbol.dispose]: dispose,
      warnings,
    },
    runUpdate,
    writes,
  };
}

function requireInitialized(opened: Opened): void {
  if (opened.handle.binding.status !== 'active') {
    throw new YHeadlessError(
      'not-initialized',
      '@lexical/y: the state has no layout record; seed the document first.',
    );
  }
}

/**
 * @experimental A headless editor bound to a new Yjs 14 document holding
 * `state`, after the layout record has been read. Throws a
 * {@link YHeadlessError} (`'read-only'`) when the binding cannot write the
 * document (a newer layout, unknown node types). With no state (or an empty
 * one) the binding is `'pending'`: write content and call
 * `binding.initialize()` to seed it.
 */
export function createHeadlessYEditor(
  options: CreateHeadlessYEditorOptions = {},
): HeadlessYEditor {
  return open(options).handle;
}

/**
 * @experimental The state of a new document whose content `$build` writes
 * into an empty root. The content is written the way a client's
 * `initialize()` writes it: with a client id derived from the content and
 * outside any undo history. Seeding identical content twice gives the same
 * bytes, and the two seeds merge into one copy; content with random parts
 * (such as ids an extension draws for new blocks) is not identical.
 */
export function seedYState(
  config: HeadlessYConfig,
  $build: () => void,
): Uint8Array {
  const opened = open(config);
  try {
    opened.runUpdate(() => {
      $getRoot().clear();
      $build();
    });
    opened.handle.binding.initialize();
    requireInitialized(opened);
    return encodeStateAsUpdate(opened.handle.doc);
  } finally {
    opened.handle.dispose();
  }
}

/**
 * @experimental Run `$edit` (one discrete editor update, plus the updates it
 * makes listeners schedule) on the document at `state` and return the update
 * it makes. The update is checked to write only to `allowedRoots`. Throws a
 * {@link YHeadlessError} when the document is not initialized or is read
 * only, or when the update writes elsewhere; an error thrown by `$edit` is
 * rethrown and nothing is written. The binding's warnings are reported
 * (`config.onWarn`, and `warnings` in the result) and do not refuse the edit.
 *
 * With `$edit` a no-op, the update is what opening the document writes (ids
 * an extension gives blocks that have none, repairs): store it once before
 * relying on {@link readYState} for such values.
 */
export function editYState(
  state: Uint8Array,
  config: HeadlessYConfig,
  $edit: () => void,
  options: EditYStateOptions = {},
): EditYStateResult {
  // What opening writes is recorded too: the edit may build on it.
  const opened = open({...config, state}, true);
  const {doc, warnings} = opened.handle;
  const updates = opened.writes;
  try {
    requireInitialized(opened);
    opened.runUpdate($edit, options.tag);
    if (options.transact) {
      const transact = options.transact;
      doc.transact(() => transact(doc));
    }
    if (updates.length === 0) {
      return {state, update: null, warnings: [...warnings]};
    }
    const update = updates.length === 1 ? updates[0] : mergeUpdates(updates);
    const allowed = new Set(
      options.allowedRoots || [config.root || DEFAULT_ROOT_NAME],
    );
    // Resolved against the headless document, which holds every parent and
    // every deleted item (it does not garbage collect).
    const {roots, unresolved} = inspectUpdateRoots(update, doc);
    const foreign = [...roots].filter(root => !allowed.has(root));
    if (foreign.length > 0 || unresolved > 0) {
      throw new YHeadlessError(
        'foreign-roots',
        `@lexical/y: the update writes outside the allowed roots (${
          foreign.length > 0 ? foreign.join(', ') : `${unresolved} unresolved`
        }).`,
      );
    }
    return {
      state: mergeUpdates([state, update] as Uint8Array<ArrayBuffer>[]),
      update,
      warnings: [...warnings],
    };
  } finally {
    opened.handle.dispose();
  }
}

/**
 * @experimental The value `$read` returns from the document at `state` (for
 * example its Markdown or `$getEditor().getEditorState().toJSON()`).
 * Nothing is written. Throws a {@link YHeadlessError} when the document is
 * not initialized or is read only.
 *
 * What opening the document writes is discarded: a value an extension
 * assigns on open (an id for a block stored without one) is read here but
 * never stored, so two reads can disagree. Store the update of a no-op
 * {@link editYState} first.
 */
export function readYState<T>(
  state: Uint8Array,
  config: HeadlessYConfig,
  $read: () => T,
): T {
  const opened = open({...config, state});
  try {
    requireInitialized(opened);
    return opened.handle.editor.read($read);
  } finally {
    opened.handle.dispose();
  }
}
