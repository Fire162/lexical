/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// `collab.inline` describes the inline instances of a class; `isInline()`
// still decides where a node sits. These classes disagree with their
// declaration at runtime: one is never inline, one flips with a field.
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  booleanValue,
  ElementNode,
  getDeclaredCollabConfig,
  type LexicalNode,
  nodeSchema,
  ParagraphNode,
  stringValue,
  type TextNode,
  withField,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  expectConverged,
  NODES,
  type Peer,
  setup,
} from '../utils/harness';

const tagSchema = nodeSchema<TagNode>()({
  tag: withField(stringValue(), {field: '__tag'}),
});

// An inline element declared as a format, like LinkNode.
class TagNode extends ElementNode {
  __tag = '';
  $config() {
    return this.config('test_tag', {
      collab: {inline: 'format'},
      extends: ElementNode,
      json: tagSchema,
    });
  }
  createDOM(): HTMLElement {
    return $getDocument().createElement('span');
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): boolean {
    return true;
  }
  setTag(tag: string): this {
    const self = this.getWritable();
    self.__tag = tag;
    return self;
  }
}

// Inherits `collab: {inline: 'format'}` from TagNode, but is never inline.
class BlockTagNode extends TagNode {
  $config() {
    return this.config('test_block_tag', {extends: TagNode});
  }
  isInline(): boolean {
    return false;
  }
}

const toggleSchema = nodeSchema<ToggleTagNode>()({
  block: withField(booleanValue(), {field: '__block'}),
});

// Inline unless its `block` field is set.
class ToggleTagNode extends TagNode {
  __block = false;
  $config() {
    return this.config('test_toggle_tag', {
      extends: TagNode,
      json: toggleSchema,
    });
  }
  isInline(): boolean {
    return !this.__block;
  }
  setBlock(block: boolean): this {
    const self = this.getWritable();
    self.__block = block;
    return self;
  }
}

// Inherits `collab: {block: 'line'}` from ParagraphNode, but is inline.
class InlineParagraphNode extends ParagraphNode {
  $config() {
    return this.config('test_inline_paragraph', {extends: ParagraphNode});
  }
  isInline(): true {
    return true;
  }
}

const nodes = [
  ...NODES,
  TagNode,
  BlockTagNode,
  ToggleTagNode,
  InlineParagraphNode,
];

const $toggle = (): ToggleTagNode =>
  $block([0]).getChildAtIndex<ToggleTagNode>(1)!;

function $text(node: LexicalNode | null): TextNode {
  return (node as ElementNode).getFirstChild<TextNode>()!;
}

/** The names of the child nodes and the format keys stored in the root. */
function stored(peer: Peer): string[] {
  const out = new Set<string>();
  for (const c of peer.binding.root.toArray()) {
    if (c instanceof Y.Node) {
      out.add(c.name);
    }
  }
  const delta = peer.binding.root.toDelta().toJSON() as {
    children?: {format?: Record<string, unknown>}[];
  };
  for (const c of delta.children ?? []) {
    for (const k of Object.keys(c.format ?? {})) {
      out.add(k);
    }
  }
  return [...out].sort();
}

describe('@lexical/y when isInline() disagrees with the collab declaration', () => {
  test('the declaration is read from the class, never from an instance', () => {
    expect(getDeclaredCollabConfig(BlockTagNode)).toEqual({inline: 'format'});
    expect(getDeclaredCollabConfig(ToggleTagNode)).toEqual({
      inline: 'format',
    });
    expect(getDeclaredCollabConfig(InlineParagraphNode)).toEqual({
      block: 'line',
    });
  });

  test('a format class that is never inline is stored as a node', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $create(BlockTagNode).setTag('a').append($createTextNode('abc')),
          $createParagraphNode().append($createTextNode('after')),
        ),
      {nodes},
    );
    expect(stored(t.a)).toContain('b:test_block_tag');
    t.offline();
    t.a.update(() => {
      $text($getRoot().getFirstChild()).spliceText(3, 0, 'X');
    });
    t.b.update(() => {
      $text($getRoot().getFirstChild()).spliceText(0, 0, 'Y');
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'test_block_tag("YabcX") / paragraph("after")',
    );
    expect(t.a.warnings).toEqual([]);
  });

  test('a line class that is inline is stored as an inline node', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('a '),
            $create(InlineParagraphNode).append($createTextNode('in')),
            $createTextNode(' b'),
          ),
        ),
      {nodes},
    );
    expect(stored(t.a)).toContain('i:test_inline_paragraph');
    t.offline();
    t.a.update(() => {
      $text($block([0]).getChildAtIndex(1)).spliceText(2, 0, 'X');
    });
    t.b.update(() => {
      $block([0]).getLastChild<TextNode>()!.spliceText(2, 0, 'Y');
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("a " test_inline_paragraph("inX") " bY")',
    );
  });

  test.each([false, true])(
    'an instance whose isInline() flips is written again in its new form (flip back: %s)',
    async flipBack => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('a '),
              $create(ToggleTagNode)
                .setTag('a')
                .append($createTextNode('link')),
              $createTextNode(' b'),
            ),
          ),
        {nodes},
      );
      // Inline: a format over its characters.
      expect(stored(t.a)).toContain('w:test_toggle_tag');
      t.a.update(() => {
        $toggle().setBlock(true);
      });
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("a " test_toggle_tag("link") " b")',
      );
      // Not inline: a node inside the line's content.
      expect(stored(t.a)).toContain('i:test_toggle_tag');
      expect(stored(t.a)).not.toContain('w:test_toggle_tag');
      expect(t.b.read(() => $toggle().isInline())).toBe(false);
      if (flipBack) {
        t.b.update(() => {
          $toggle().setBlock(false);
        });
        await t.sync();
        await expectConverged(
          t.peers,
          'paragraph("a " test_toggle_tag("link") " b")',
        );
        expect(t.a.read(() => $toggle().isInline())).toBe(true);
        expect(stored(t.a)).toContain('w:test_toggle_tag');
      }
    },
  );

  // A flip changes the node's representation (its characters are written
  // again), like a move: text a peer types inside it at the same time lands
  // next to it. Nothing is lost and every peer converges.
  test.each([
    [[1, 2], 'causal'],
    [[2, 1], 'causal'],
    [[1, 2], 'sender'],
    [[2, 1], 'sender'],
  ] as const)(
    'a flip races typing inside the node (ids %j, %s)',
    async (ids, delivery) => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('a '),
              $create(ToggleTagNode)
                .setTag('a')
                .append($createTextNode('link')),
              $createTextNode(' b'),
            ),
          ),
        {delivery, ids: [...ids], nodes},
      );
      t.offline();
      t.a.update(() => {
        $toggle().setBlock(true);
      });
      t.b.update(() => {
        $text($toggle()).spliceText(4, 0, 'Z');
      });
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("a Z" test_toggle_tag("link") " b")',
      );
      expect(t.a.read(() => $toggle().isInline())).toBe(false);
    },
  );
});
