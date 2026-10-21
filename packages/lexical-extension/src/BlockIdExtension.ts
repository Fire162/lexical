/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $getNodeByKey,
  $getRoot,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $getSlotNameWithinHost,
  $getState,
  $hasUpdateTag,
  $isDecoratorNode,
  $isElementNode,
  $isRootNode,
  $isSlotHost,
  $isTextNode,
  $setState,
  COLLABORATION_TAG,
  createState,
  defineExtension,
  type EditorState,
  HISTORIC_TAG,
  HISTORY_MERGE_TAG,
  type InitialEditorConfig,
  type LexicalEditor,
  type LexicalNode,
  LineBreakNode,
  NODE_STATE_DIRECT,
  type NodeKey,
  RootNode,
  safeCast,
  TextNode,
} from 'lexical';

import {$getExtensionOutput} from './getExtensionDependency';
import {namedSignals} from './namedSignals';
import {effect, type Signal} from './signals';

const __DEV__ = process.env.NODE_ENV !== 'production';

/** The longest id accepted from JSON, HTML, or a remote peer. */
const MAX_BLOCK_ID_LENGTH = 128;

/** 64 URL-safe characters, so one random byte masked to 6 bits picks one. */
const ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/**
 * Length of ids made by {@link generateBlockId}: 21 characters of 6 bits, 126
 * random bits (more than the 122 of a version 4 UUID; nanoid's default). Ids are
 * made by independent peers and servers that cannot coordinate, so the size
 * alone has to make a collision between ids that coexist in a document
 * practically impossible.
 */
const GENERATED_ID_LENGTH = 21;

/**
 * Attempts to find an unused id before giving up, which only a broken
 * `generateId` (one that keeps returning ids already in use) can exhaust.
 */
const MAX_ID_ATTEMPTS = 32;

/**
 * Tag of the follow-up update that repairs ids after a commit that did not run
 * transforms (a remote collaboration change, for instance).
 */
const BLOCK_ID_REPAIR_TAG = 'block-id-repair';

function parseBlockId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_BLOCK_ID_LENGTH
    ? value
    : undefined;
}

/**
 * The NodeState that stores a block's id, serialized in node JSON as
 * `"$": {"blockId": "..."}`.
 *
 * It is ordinary NodeState, so it survives clones and undo, round-trips
 * through `exportJSON`/`importJSON`, and is synchronized by any collaboration
 * binding that synchronizes NodeState. It is reset by `$copyNode`, so a node
 * split off another one (e.g. the new `ListItemNode` that Enter creates) starts
 * without an id instead of with a duplicate.
 *
 * Any non-empty string of at most 128 characters is accepted; anything else
 * reads as "no id".
 *
 * @experimental
 */
export const blockIdState = createState('blockId', {
  parse: parseBlockId,
  resetOnCopyNode: true,
});

/**
 * Returns the id stored on `node`, or `null` if it has none.
 *
 * This reads the NodeState directly, so it also returns an id left on a node
 * that is not an identified block (one moved into a list item, say); such ids
 * are not indexed and {@link $getBlockById} does not find them.
 *
 * @experimental
 */
export function $getBlockId(node: LexicalNode): string | null {
  const id = $getState(node, blockIdState);
  return id === undefined ? null : id;
}

/**
 * Returns the identified block with the given id in the active editor state,
 * or `null`. Requires {@link BlockIdExtension}.
 *
 * The lookup goes through an index kept up to date from the dirty nodes of
 * each commit and is verified against the active state, so it never returns a
 * stale node. A block created or re-keyed earlier in the same update is found
 * once that update has committed.
 *
 * @experimental
 */
export function $getBlockById(id: string): LexicalNode | null {
  return $getExtensionOutput(BlockIdExtension).$getBlockById(id);
}

/**
 * The default {@link BlockIdConfig.$isIdentifiedBlock}: the element and
 * decorator children of the root. Compose it to identify nested blocks too:
 *
 * ```ts
 * configExtension(BlockIdExtension, {
 *   $isIdentifiedBlock: (node) =>
 *     $defaultIsIdentifiedBlock(node) || $isListItemNode(node),
 * });
 * ```
 *
 * @experimental
 */
export function $defaultIsIdentifiedBlock(node: LexicalNode): boolean {
  return (
    ($isElementNode(node) || $isDecoratorNode(node)) &&
    $isRootNode(node.getParent())
  );
}

/**
 * The default {@link BlockIdConfig.generateId}: 21 characters from the
 * URL-safe base64 alphabet (126 random bits), from `crypto.getRandomValues`
 * where available. Ids need no coordination between collaborators or
 * servers: ids made independently practically never collide, and a mistyped
 * id (from a language model, say) almost never names another block.
 *
 * @experimental
 */
export function generateBlockId(): string {
  const bytes = new Uint8Array(GENERATED_ID_LENGTH);
  const cryptoImpl = typeof crypto === 'undefined' ? undefined : crypto;
  if (cryptoImpl && typeof cryptoImpl.getRandomValues === 'function') {
    cryptoImpl.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let id = '';
  for (let i = 0; i < bytes.length; i++) {
    id += ID_ALPHABET[bytes[i] & 63];
  }
  return id;
}

/** @experimental */
export interface BlockIdConfig {
  /**
   * Set to `true` to stop assigning, repairing, and indexing ids. Ids already
   * stored on nodes are kept. While disabled, {@link $getBlockById} falls back
   * to a scan of the document.
   */
  disabled: boolean;
  /**
   * Which nodes get an id. Evaluated when a node is marked dirty, so it should
   * depend only on the node and its ancestors. Default:
   * {@link $defaultIsIdentifiedBlock} (the children of the root).
   */
  $isIdentifiedBlock: (node: LexicalNode) => boolean;
  /**
   * Makes a new id. It must return a non-empty string of at most 128
   * characters. A collision with an id in use in this editor is retried, but
   * ids made concurrently by collaborators cannot see each other, so a
   * replacement must stay unique across peers (random ids of 120 bits or
   * more, or a per-peer prefix). Tests can inject a deterministic counter.
   * Default: {@link generateBlockId}.
   */
  generateId: () => string;
}

/** @experimental */
export interface BlockIdOutput {
  /** See {@link BlockIdConfig.disabled}. */
  disabled: Signal<boolean>;
  /** The same as {@link $getBlockById} for this editor. */
  $getBlockById: (id: string) => LexicalNode | null;
  /** The configured {@link BlockIdConfig.$isIdentifiedBlock}. */
  $isIdentifiedBlock: (node: LexicalNode) => boolean;
}

/**
 * An index of the committed editor state: id → keys of the identified blocks
 * that carry it (almost always one), and key → id.
 */
class BlockIdIndex {
  /** One holder per id. */
  readonly primary = new Map<string, NodeKey>();
  /** Further holders of an id, only while a duplicate awaits repair. */
  readonly extra = new Map<string, Set<NodeKey>>();
  readonly idOfKey = new Map<NodeKey, string>();

  clear(): void {
    this.primary.clear();
    this.extra.clear();
    this.idOfKey.clear();
  }

  has(id: string): boolean {
    return this.primary.has(id);
  }

  holders(id: string): NodeKey[] {
    const first = this.primary.get(id);
    if (first === undefined) {
      return [];
    }
    const rest = this.extra.get(id);
    return rest === undefined ? [first] : [first, ...rest];
  }

  set(key: NodeKey, id: string): void {
    const prevId = this.idOfKey.get(key);
    if (prevId === id) {
      return;
    }
    if (prevId !== undefined) {
      this.remove(key);
    }
    this.idOfKey.set(key, id);
    const first = this.primary.get(id);
    if (first === undefined) {
      this.primary.set(id, key);
    } else {
      let rest = this.extra.get(id);
      if (rest === undefined) {
        rest = new Set();
        this.extra.set(id, rest);
      }
      rest.add(key);
    }
  }

  remove(key: NodeKey): void {
    const id = this.idOfKey.get(key);
    if (id === undefined) {
      return;
    }
    this.idOfKey.delete(key);
    const rest = this.extra.get(id);
    if (this.primary.get(id) === key) {
      if (rest === undefined) {
        this.primary.delete(id);
      } else {
        const [next] = rest;
        rest.delete(next);
        this.primary.set(id, next);
        if (rest.size === 0) {
          this.extra.delete(id);
        }
      }
    } else if (rest !== undefined) {
      rest.delete(key);
      if (rest.size === 0) {
        this.extra.delete(id);
      }
    }
  }
}

/** Per-editor state, the init result of {@link BlockIdExtension}. */
interface BlockIdRuntime {
  readonly config: BlockIdConfig;
  readonly index: BlockIdIndex;
  /** Whether `index` is being maintained (the extension is enabled). */
  active: boolean;
  $getBlockById: (id: string) => LexicalNode | null;
}

declare const LiveIdentifiedBlockBrand: unique symbol;
/**
 * An attached node that the predicate identifies. Branded, so that a `false`
 * from {@link $isLiveIdentified} does not narrow its argument to `null`.
 */
type LiveIdentifiedBlock = LexicalNode & {
  readonly [LiveIdentifiedBlockBrand]: never;
};

/** Pushes the children and the slot values of `node` onto `stack`. */
function $pushContents(node: LexicalNode, stack: LexicalNode[]): void {
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      stack.push(child);
    }
  }
  if ($isSlotHost(node)) {
    for (const name of $getSlotNames(node)) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        stack.push(slot);
      }
    }
  }
}

/** The previous-state id of a frozen node, read without an active state. */
function $prevIdOf(node: undefined | LexicalNode): string | null {
  if (node === undefined) {
    return null;
  }
  const id = $getState(node, blockIdState, NODE_STATE_DIRECT);
  return id === undefined ? null : id;
}

function $isLiveIdentified(
  runtime: BlockIdRuntime,
  node: null | LexicalNode,
): node is LiveIdentifiedBlock {
  return (
    node !== null &&
    node.isAttached() &&
    runtime.config.$isIdentifiedBlock(node)
  );
}

/** Attached identified blocks of the active state that carry `id`. */
function $liveHolders(
  runtime: BlockIdRuntime,
  id: string,
  extraKeys: Iterable<NodeKey> = [],
): LexicalNode[] {
  const seen = new Set<NodeKey>();
  const result: LexicalNode[] = [];
  const visit = (key: NodeKey) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const node = $getNodeByKey(key);
    if ($isLiveIdentified(runtime, node) && $getBlockId(node) === id) {
      result.push(node);
    }
  };
  for (const key of runtime.index.holders(id)) {
    visit(key);
  }
  for (const key of extraKeys) {
    visit(key);
  }
  return result;
}

/** The parent of `node`, or the host of the slot that it occupies. */
function $getContainer(node: LexicalNode): LexicalNode | null {
  const parent = node.getParent();
  return parent !== null ? parent : $getSlotHost(node);
}

/**
 * Document order of two nodes of the active state: pre-order, with the
 * values of a host's slots (in its canonical slot order) before its children,
 * as `$dfsWithSlots` visits them. Every peer computes the same order for the
 * same document. It costs O(depth) plus a walk over the siblings between the
 * two branches, like `isBefore`, which ignores slots.
 */
function $compareDocumentOrder(a: LexicalNode, b: LexicalNode): number {
  if (a.is(b)) {
    return 0;
  }
  // Container key → the node below it on the way up from `a`.
  const below = new Map<NodeKey, LexicalNode>();
  for (
    let child = a, container = $getContainer(a);
    container !== null;
    child = container, container = $getContainer(container)
  ) {
    below.set(container.getKey(), child);
  }
  if (below.has(b.getKey())) {
    // `b` is an ancestor of `a`.
    return 1;
  }
  for (
    let bChild = b, container = $getContainer(b);
    container !== null;
    bChild = container, container = $getContainer(container)
  ) {
    if (container.is(a)) {
      // `a` is an ancestor of `b`.
      return -1;
    }
    const aChild = below.get(container.getKey());
    if (aChild === undefined) {
      continue;
    }
    // `container` is the closest common one; compare the two branches.
    const aSlot = $getSlotNameWithinHost(aChild);
    const bSlot = $getSlotNameWithinHost(bChild);
    if (aSlot !== null || bSlot !== null) {
      if (aSlot === null || bSlot === null) {
        // Slots come before children.
        return aSlot === null ? 1 : -1;
      }
      const names = $getSlotNames(container);
      return names.indexOf(aSlot) - names.indexOf(bSlot);
    }
    const aKey = aChild.getKey();
    const bKey = bChild.getKey();
    let na: LexicalNode | null = aChild;
    let nb: LexicalNode | null = bChild;
    for (
      ;
      na !== null && nb !== null;
      na = na.getNextSibling(), nb = nb.getNextSibling()
    ) {
      if (na.getKey() === bKey) {
        return -1;
      } else if (nb.getKey() === aKey) {
        return 1;
      }
    }
    // The walk from `a` reached the end first: `b` comes before it.
    return na === null ? 1 : -1;
  }
  // Not in the same tree (cannot happen for attached nodes): any stable
  // answer will do.
  return compareKeys(a, b);
}

/**
 * The first of `nodes` in document order (see {@link $compareDocumentOrder}).
 * This is the tie-break between holders of an id that were committed
 * together, which every collaborator must resolve the same way; node keys
 * cannot be used for it, because each peer numbers the nodes that it
 * receives in its own order. It runs only to repair a committed duplicate.
 */
function $firstInDocumentOrder<T extends LexicalNode>(nodes: T[]): T {
  return nodes.reduce((first, node) =>
    $compareDocumentOrder(node, first) < 0 ? node : first,
  );
}

/**
 * Creation order. Node keys come from a counter that only increases within
 * one JavaScript realm, so this orders nodes that one local update created;
 * it is used only for decisions that a single peer makes and then shares.
 */
function compareKeys(a: LexicalNode, b: LexicalNode): number {
  return Number(a.getKey()) - Number(b.getKey());
}

function $makeFreshId(runtime: BlockIdRuntime, used: Set<string>): string {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = runtime.config.generateId();
    if (
      parseBlockId(id) === id &&
      !used.has(id) &&
      $liveHolders(runtime, id).length === 0
    ) {
      used.add(id);
      return id;
    }
  }
  invariant(
    false,
    'BlockIdExtension: generateId returned %s ids in a row that were invalid or already in use',
    String(MAX_ID_ATTEMPTS),
  );
}

/**
 * Runs as the RootNode transform, which Lexical applies after every other
 * transform of the same pass. `candidates` holds the identified blocks marked
 * dirty in this update.
 *
 * 1. Lineage, for blocks created in this update, using the previous state:
 *    - a block that took the children of a removed block (a type change via
 *      `replace(…, true)`) takes its id;
 *    - a block that took all the children of a block that is now empty (Enter
 *      at the start of a block) takes its id, and the emptied block gets a
 *      new one;
 *    - an empty block that sits exactly where a removed block sat (a type
 *      change of an empty block) takes its id.
 *    - a new block in the slot of a host where a removed block sat
 *      (`$setSlot` replacing a slot value) takes its id.
 * 2. Every candidate without an id gets a fresh one.
 * 3. Every id carried by a candidate and by any other identified block is
 *    kept by the one block that carried it before this update. When several
 *    did (a duplicate that was committed, by a remote merge for instance),
 *    the earliest of them in document order keeps it, which every
 *    collaborator computes alike. When none did (all of them got it in this
 *    local update), the first one created keeps it: one peer makes that
 *    decision and shares the result. The others get fresh ids. Fresh ids of
 *    steps 2 and 3 are generated in creation order.
 */
function $assignBlockIds(
  editor: LexicalEditor,
  runtime: BlockIdRuntime,
  candidates: Set<NodeKey>,
): void {
  if (candidates.size === 0) {
    return;
  }
  const keys = Array.from(candidates);
  candidates.clear();
  if ($hasUpdateTag(COLLABORATION_TAG) || $hasUpdateTag(HISTORIC_TAG)) {
    // Bindings do not write changes made during these updates back to the
    // shared document, so the repair runs in a follow-up update instead (see
    // the update listener).
    return;
  }
  const blocks: LexicalNode[] = [];
  for (const key of keys) {
    const node = $getNodeByKey(key);
    if ($isLiveIdentified(runtime, node)) {
      blocks.push(node);
    }
  }
  if (blocks.length === 0) {
    return;
  }
  const blockKeys = new Set(blocks.map(node => node.getKey()));
  const prevNodeMap = editor.getEditorState()._nodeMap;
  const used = new Set<string>();
  // New key → key of the previous-state block it continues.
  const lineage = new Map<NodeKey, NodeKey>();

  const $isRemoved = (key: null | NodeKey): key is NodeKey => {
    if (key === null) {
      return false;
    }
    // A node removed in this update is still in the pending node map, only
    // detached. A key that is missing altogether belongs to a state that was
    // replaced wholesale (setEditorState), which has no lineage.
    const node = $getNodeByKey(key);
    return node !== null && !node.isAttached();
  };
  const $isTaken = (id: string, except: NodeKey): boolean =>
    used.has(id) ||
    $liveHolders(runtime, id).some(node => node.getKey() !== except);
  const $inherit = (node: LexicalNode, id: string, fromKey: NodeKey) => {
    lineage.set(node.getKey(), fromKey);
    used.add(id);
    if ($getBlockId(node) !== id) {
      $setState(node, blockIdState, id);
    }
  };

  // 1a. Children-based lineage.
  const newBlocks = blocks.filter(node => !prevNodeMap.has(node.getKey()));
  for (const node of newBlocks) {
    const ownId = $getBlockId(node);
    if (!$isElementNode(node)) {
      continue;
    }
    const firstChild = node.getFirstChild();
    if (firstChild === null) {
      continue;
    }
    const prevChild = prevNodeMap.get(firstChild.getKey());
    if (prevChild === undefined || prevChild.__parent === null) {
      continue;
    }
    const sourceKey = prevChild.__parent;
    const prevSource = prevNodeMap.get(sourceKey);
    const id = $prevIdOf(prevSource);
    if (id === null || (ownId !== null && ownId !== id)) {
      continue;
    }
    if ($isRemoved(sourceKey)) {
      // Replaced, e.g. by $setBlocksType.
      if (!$isTaken(id, sourceKey)) {
        $inherit(node, id, sourceKey);
      }
      continue;
    }
    const source = $getNodeByKey(sourceKey);
    if (
      $isElementNode(source) &&
      source.isAttached() &&
      source.getChildrenSize() === 0 &&
      $isElementNode(prevSource) &&
      prevSource.__first === firstChild.getKey() &&
      $getBlockId(source) === id &&
      !used.has(id)
    ) {
      // All of the content moved on (Enter at the start): the id follows it,
      // and the emptied block is re-keyed below.
      $setState(source, blockIdState, $makeFreshId(runtime, used));
      $inherit(node, id, sourceKey);
    }
  }

  // 1b. Position-based lineage for the remaining new blocks without an id.
  const resolved = new Set<NodeKey>();
  const $resolvePosition = (start: LexicalNode) => {
    const stack: LexicalNode[] = [start];
    while (stack.length > 0) {
      const node = stack[stack.length - 1];
      const key = node.getKey();
      if (resolved.has(key)) {
        stack.pop();
        continue;
      }
      const prevSibling = node.getPreviousSibling();
      if (
        prevSibling !== null &&
        !prevNodeMap.has(prevSibling.getKey()) &&
        blockKeys.has(prevSibling.getKey()) &&
        !resolved.has(prevSibling.getKey())
      ) {
        // Resolve the new block before this one first: a run of replaced
        // blocks is matched against the removed run in order.
        stack.push(prevSibling);
        continue;
      }
      stack.pop();
      resolved.add(key);
      if (lineage.has(key) || $getBlockId(node) !== null) {
        continue;
      }
      let removedKey: null | NodeKey = null;
      const host = $getSlotHost(node);
      if (host !== null) {
        // A slot value: the block that held the same slot before.
        const prevHost = prevNodeMap.get(host.getKey());
        const name = $getSlotNameWithinHost(node);
        removedKey =
          prevHost !== undefined &&
          $isSlotHost(prevHost) &&
          prevHost.__slots !== null &&
          name !== null
            ? (prevHost.__slots.get(name) ?? null)
            : null;
      } else if (prevSibling === null) {
        const parent = node.getParent();
        const prevParent = parent && prevNodeMap.get(parent.getKey());
        removedKey = $isElementNode(prevParent) ? prevParent.__first : null;
      } else {
        const anchorKey = prevNodeMap.has(prevSibling.getKey())
          ? prevSibling.getKey()
          : lineage.get(prevSibling.getKey());
        const prevAnchor =
          anchorKey === undefined ? undefined : prevNodeMap.get(anchorKey);
        removedKey = prevAnchor === undefined ? null : prevAnchor.__next;
      }
      if ($isRemoved(removedKey)) {
        const id = $prevIdOf(prevNodeMap.get(removedKey));
        if (id !== null && !$isTaken(id, removedKey)) {
          $inherit(node, id, removedKey);
        }
      }
    }
  };
  for (const node of newBlocks) {
    $resolvePosition(node);
  }

  // 2. Blocks without an id, and 3. all but one holder of an id
  // that several identified blocks carry, get fresh ids, assigned in
  // creation order (deterministic, and cheap).
  const candidatesById = new Map<string, NodeKey[]>();
  const needFresh: LexicalNode[] = [];
  for (const node of blocks) {
    const id = $getBlockId(node);
    if (id === null) {
      needFresh.push(node);
    } else {
      const keysWithId = candidatesById.get(id);
      if (keysWithId === undefined) {
        candidatesById.set(id, [node.getKey()]);
      } else {
        keysWithId.push(node.getKey());
      }
    }
  }
  for (const [id, keysWithId] of candidatesById) {
    const holders = $liveHolders(runtime, id, keysWithId);
    if (holders.length > 1) {
      used.add(id);
      // A block that already carried the id before this update keeps it; a
      // block that got it in this update (a paste, a duplicate, an import)
      // yields.
      const existing = holders.filter(
        node => $prevIdOf(prevNodeMap.get(node.getKey())) === id,
      );
      const keeper =
        existing.length === 1
          ? existing[0]
          : existing.length > 1
            ? // A committed duplicate: every peer that sees it repairs it, so
              // they must agree, whatever keys they gave the nodes.
              $firstInDocumentOrder(existing)
            : // Every holder got the id in this local update, which only this
              // peer runs: creation order is enough, and cheap.
              holders.reduce((a, b) => (compareKeys(b, a) < 0 ? b : a));
      for (const node of holders) {
        if (!node.is(keeper)) {
          needFresh.push(node);
        }
      }
    }
  }
  for (const node of needFresh.sort(compareKeys)) {
    $setState(node, blockIdState, $makeFreshId(runtime, used));
  }
}

/**
 * Brings the index up to date with a committed state. Returns the keys of
 * identified blocks that lack an id or share one, which need a repair update.
 */
function $syncIndex(
  runtime: BlockIdRuntime,
  editorState: EditorState,
  prevEditorState: EditorState,
  dirtyElements: Map<NodeKey, boolean>,
  dirtyLeaves: Set<NodeKey>,
): NodeKey[] {
  const {index, config} = runtime;
  const nodeMap = editorState._nodeMap;
  const prevNodeMap = prevEditorState._nodeMap;
  const needsRepair: NodeKey[] = [];
  const touchedIds = new Set<string>();

  const visit = (node: LexicalNode) => {
    const key = node.getKey();
    if (node.isAttached() && config.$isIdentifiedBlock(node)) {
      const id = $getBlockId(node);
      if (id === null) {
        index.remove(key);
        needsRepair.push(key);
      } else {
        index.set(key, id);
        touchedIds.add(id);
      }
    } else {
      index.remove(key);
    }
  };

  if (
    dirtyLeaves.size === 0 &&
    dirtyElements.size === 1 &&
    dirtyElements.has('root')
  ) {
    // Only the root is dirty: the state was replaced with setEditorState (an
    // undo or redo, for instance) and nothing says which nodes changed.
    // Rebuild, which costs the same order as the full reconciliation that
    // Lexical performs for such a commit.
    index.clear();
    const stack: LexicalNode[] = [];
    $pushContents($getRoot(), stack);
    while (stack.length > 0) {
      const node = stack.pop()!;
      if ($isTextNode(node)) {
        continue;
      }
      visit(node);
      $pushContents(node, stack);
    }
  } else {
    const removeSubtree = (key: NodeKey) => {
      const stack: NodeKey[] = [key];
      while (stack.length > 0) {
        const k = stack.pop()!;
        if (nodeMap.has(k)) {
          // Moved elsewhere; it is dirty itself if it matters.
          continue;
        }
        index.remove(k);
        const prevNode = prevNodeMap.get(k);
        if ($isElementNode(prevNode)) {
          let child = prevNode.__first;
          while (child !== null) {
            stack.push(child);
            const prevChild = prevNodeMap.get(child);
            child = prevChild === undefined ? null : prevChild.__next;
          }
        }
        if (
          prevNode !== undefined &&
          $isSlotHost(prevNode) &&
          prevNode.__slots !== null
        ) {
          for (const slotKey of prevNode.__slots.values()) {
            stack.push(slotKey);
          }
        }
      }
    };
    const visitKey = (key: NodeKey) => {
      const node = nodeMap.get(key);
      if (node === undefined) {
        removeSubtree(key);
      } else if (!$isTextNode(node)) {
        visit(node);
      }
    };
    for (const [key, intentional] of dirtyElements) {
      // Elements marked dirty only because a descendant changed cannot have
      // changed id, position, or identity.
      if (intentional) {
        visitKey(key);
      }
    }
    for (const key of dirtyLeaves) {
      visitKey(key);
    }
  }

  for (const id of touchedIds) {
    if (index.extra.has(id)) {
      const holders = $liveHolders(runtime, id);
      if (holders.length > 1) {
        for (const node of holders) {
          needsRepair.push(node.getKey());
        }
      }
    }
  }
  return needsRepair;
}

function $rebuildIndex(
  runtime: BlockIdRuntime,
  editorState: EditorState,
): NodeKey[] {
  return $syncIndex(
    runtime,
    editorState,
    editorState,
    new Map([['root', false]]),
    new Set(),
  );
}

function registerBlockIds(
  editor: LexicalEditor,
  runtime: BlockIdRuntime,
): () => void {
  const candidates = new Set<NodeKey>();
  const {$isIdentifiedBlock} = runtime.config;
  const collect = (node: LexicalNode) => {
    if ($isIdentifiedBlock(node)) {
      candidates.add(node.getKey());
    }
  };
  const scheduleRepair = (keys: NodeKey[]) => {
    editor.update(
      () => {
        for (const key of keys) {
          const node = $getNodeByKey(key);
          if (node !== null && node.isAttached()) {
            node.markDirty();
          }
        }
      },
      // Discrete, so it commits on its own right after the commit that needed
      // it: batched into a later collaboration update, its changes would not
      // be written to the shared document.
      {discrete: true, tag: [HISTORY_MERGE_TAG, BLOCK_ID_REPAIR_TAG]},
    );
  };

  runtime.index.clear();
  runtime.active = true;
  const currentState = editor.getEditorState();
  const initialRepairs = currentState.read(
    () => $rebuildIndex(runtime, currentState),
    {editor},
  );

  const cleanups: (() => void)[] = [
    editor.registerUpdateListener(
      ({editorState, prevEditorState, dirtyElements, dirtyLeaves, tags}) => {
        const repairs = editorState.read(
          () =>
            $syncIndex(
              runtime,
              editorState,
              prevEditorState,
              dirtyElements,
              dirtyLeaves,
            ),
          {editor},
        );
        if (repairs.length > 0) {
          if (tags.has(BLOCK_ID_REPAIR_TAG)) {
            if (__DEV__) {
              console.warn(
                'BlockIdExtension: a repair update left blocks without a unique id; is $isIdentifiedBlock stable?',
              );
            }
          } else {
            scheduleRepair(repairs);
          }
        }
      },
    ),
  ];
  // Registering a transform marks every node of that type dirty, so the first
  // update assigns ids to a document that was opened without them.
  for (const {klass} of editor._nodes.values()) {
    if (
      klass === RootNode ||
      klass === TextNode ||
      klass === LineBreakNode ||
      klass.prototype instanceof TextNode
    ) {
      continue;
    }
    cleanups.push(editor.registerNodeTransform(klass, collect));
  }
  cleanups.push(
    editor.registerNodeTransform(RootNode, () =>
      $assignBlockIds(editor, runtime, candidates),
    ),
  );
  if (initialRepairs.length > 0) {
    scheduleRepair(initialRepairs);
  }
  return () => {
    for (const cleanup of cleanups.reverse()) {
      cleanup();
    }
    runtime.active = false;
    runtime.index.clear();
    candidates.clear();
  };
}

function createRuntime(config: BlockIdConfig): BlockIdRuntime {
  const runtime: BlockIdRuntime = {
    $getBlockById(id: string): LexicalNode | null {
      if (!runtime.active) {
        // Not indexed while disabled: scan.
        const found: LexicalNode[] = [];
        const stack: LexicalNode[] = [];
        $pushContents($getRoot(), stack);
        while (stack.length > 0) {
          const node = stack.pop()!;
          if ($isTextNode(node)) {
            continue;
          }
          if (config.$isIdentifiedBlock(node) && $getBlockId(node) === id) {
            found.push(node);
          }
          $pushContents(node, stack);
        }
        return found.length === 0 ? null : $firstInDocumentOrder(found);
      }
      const holders = $liveHolders(runtime, id);
      // Several holders only until the repair update: return the one that
      // the repair will leave the id on.
      return holders.length === 0 ? null : $firstInDocumentOrder(holders);
    },
    active: false,
    config,
    index: new BlockIdIndex(),
  };
  return runtime;
}

/**
 * Gives blocks stable ids, stored as NodeState ({@link blockIdState}), so that
 * code outside the editor (an AI agent, a server pipeline, a comment system)
 * can address a block by id across sessions, collaborators, and serializations.
 *
 * - Every identified block (see {@link BlockIdConfig.$isIdentifiedBlock})
 *   gets an id in the same update that creates it, whether it was typed,
 *   pasted, or produced by `importJSON`, `importDOM`, or a markdown import. A
 *   document loaded without ids gets them in the update that loads it (or in
 *   the first update after the extension is registered).
 * - Ids are unique: when several identified blocks share one, a block that
 *   already had it keeps it and blocks that got it in this update (a paste,
 *   a duplicate, an import) get fresh ids, so a reference never jumps to a
 *   copy. Between blocks that all had it before (a duplicate made by merging
 *   concurrent edits), the earliest in document order keeps it, so
 *   collaborators repairing the same duplicate concurrently converge; between
 *   blocks that all got it in one local update, the first one created does.
 * - Blocks inside slots are covered wherever the predicate identifies them.
 * - Splits, joins, type changes, moves, and undo/redo keep ids with the
 *   content the user sees; see the documentation for the exact rules.
 * - {@link $getBlockById} finds a block from an index that is maintained from
 *   the dirty nodes of each update, never from a scan of the document.
 *
 * @experimental
 */
export const BlockIdExtension = defineExtension({
  build(editor, config, state): BlockIdOutput {
    const runtime = state.getInitResult();
    const signals = namedSignals({disabled: config.disabled});
    return {
      $getBlockById: runtime.$getBlockById,
      $isIdentifiedBlock: config.$isIdentifiedBlock,
      disabled: signals.disabled,
    };
  },
  config: safeCast<BlockIdConfig>({
    $isIdentifiedBlock: $defaultIsIdentifiedBlock,
    disabled: false,
    generateId: generateBlockId,
  }),
  // The index and the rest of the per-editor state live in the init result,
  // which the output does not expose. The parameters are annotated so that
  // TypeScript infers the init type before it checks build and register.
  init: (editorConfig: InitialEditorConfig, config: BlockIdConfig) =>
    createRuntime(config),
  name: '@lexical/extension/BlockId',
  register(editor, config, state) {
    const output = state.getOutput();
    const runtime = state.getInitResult();
    return effect(() => {
      if (!output.disabled.value) {
        return registerBlockIds(editor, runtime);
      }
    });
  },
});
