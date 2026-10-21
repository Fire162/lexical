/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $defaultIsIdentifiedBlock,
  $getBlockById,
  $getBlockId,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $isDecoratorNode,
  $isElementNode,
  $removeSlot,
  $setSlot,
  $setState,
  COLLABORATION_TAG,
  configExtension,
  defineExtension,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  UNDO_COMMAND,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

/** A shadow-root slot value that holds several blocks. */
class SlotContainerNode extends ElementNode {
  $config() {
    return this.config('block-id-slot-container', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}

function $isSlotContainer(node: LexicalNode | null): boolean {
  return node instanceof SlotContainerNode;
}

/**
 * The root's children, plus the blocks inside a slot: a slot value that is
 * a block itself, or the children of a slot container.
 */
function $isIdentifiedBlockWithSlots(node: LexicalNode): boolean {
  if ($defaultIsIdentifiedBlock(node)) {
    return true;
  }
  if (!($isElementNode(node) || $isDecoratorNode(node)) || node.isInline()) {
    return false;
  }
  if ($getSlotHost(node) !== null) {
    return !$isSlotContainer(node);
  }
  const parent = node.getParent();
  return parent !== null && $isSlotContainer(parent);
}

function counter(prefix = 'b') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function build(
  options: {disabled?: boolean; history?: boolean} = {},
): LexicalEditorWithDispose {
  let clock = 0;
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        ...(options.history
          ? [
              configExtension(HistoryExtension, {
                disabled: false,
                now: () => (clock += 10000),
              }),
            ]
          : []),
        configExtension(BlockIdExtension, {
          $isIdentifiedBlock: $isIdentifiedBlockWithSlots,
          disabled: options.disabled || false,
          generateId: counter(),
        }),
      ],
      name: '[block-id-slots-test]',
      nodes: [SlotContainerNode],
    }),
  );
}

function update(
  editor: LexicalEditor,
  fn: () => void,
  options: {skipTransforms?: true; tag?: string} = {},
): void {
  editor.update(fn, {discrete: true, ...options});
}

function $paragraph(text: string, id?: string): ElementNode {
  const node = $createParagraphNode().append($createTextNode(text));
  if (id !== undefined) {
    $setState(node, blockIdState, id);
  }
  return node;
}

function $host(index: number): ElementNode {
  const node = $getRoot().getChildAtIndex(index);
  assert($isElementNode(node));
  return node;
}

function $container(index: number, name = 'title'): ElementNode {
  const slot = $getSlot($host(index), name);
  assert($isElementNode(slot) && $isSlotContainer(slot));
  return slot;
}

/**
 * Every identified block in document order (a host's slots before its
 * children), as `text:id`, indented by depth.
 */
function outline(editor: LexicalEditor): string[] {
  return editor.read(() => {
    const out: string[] = [];
    const visit = (node: LexicalNode, depth: number) => {
      if ($isIdentifiedBlockWithSlots(node)) {
        // The block's own text, without that of its slots.
        const text = $isElementNode(node)
          ? node
              .getChildren()
              .map(child => child.getTextContent())
              .join('')
          : node.getTextContent();
        out.push(`${'  '.repeat(depth)}${text}:${$getBlockId(node)}`);
      }
      if ($isElementNode(node) || $isDecoratorNode(node)) {
        for (const name of $getSlotNames(node)) {
          const slot = $getSlot(node, name);
          if (slot !== null) {
            visit(slot, depth + 1);
          }
        }
      }
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) {
          visit(child, depth + 1);
        }
      }
    };
    for (const child of $getRoot().getChildren()) {
      visit(child, 0);
    }
    return out;
  });
}

/** A root paragraph `host` with a `title` slot container holding `texts`. */
function $hostWithSlot(host: string, texts: string[]): ElementNode {
  const node = $paragraph(host);
  const container = $create(SlotContainerNode).append(
    ...texts.map(text => $paragraph(text)),
  );
  $setSlot(node, 'title', container);
  return node;
}

describe('BlockIdExtension: slots', () => {
  test('blocks inside a slot get ids in the commit that creates them', () => {
    using editor = build();
    const ids: (string | null)[][] = [];
    editor.registerUpdateListener(({editorState}) => {
      ids.push(
        editorState.read(() =>
          $container(0)
            .getChildren()
            .map(node => $getBlockId(node)),
        ),
      );
    });
    update(editor, () => {
      $getRoot().append($hostWithSlot('host', ['one', 'two']));
    });
    expect(ids).toEqual([['b2', 'b3']]);
    expect(outline(editor)).toEqual(['host:b1', '    one:b2', '    two:b3']);
    editor.read(() => {
      expect($getBlockById('b3')!.getTextContent()).toBe('two');
    });
  });

  test('a block that is itself a slot value gets an id', () => {
    using editor = build();
    update(editor, () => {
      const host = $paragraph('host');
      $getRoot().append(host);
      $setSlot(host, 'caption', $paragraph('caption'));
    });
    expect(outline(editor)).toEqual(['host:b1', '  caption:b2']);
  });

  test('a duplicate inside a slot yields to the existing block', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append($hostWithSlot('host', ['one']), $paragraph('two'));
    });
    expect(outline(editor)).toEqual(['host:b1', '    one:b2', 'two:b3']);
    // A copy of the last root block pasted into the slot, before the
    // original in document order.
    update(editor, () => {
      $container(0).append($paragraph('copy of two', 'b3'));
    });
    expect(outline(editor)).toEqual([
      'host:b1',
      '    one:b2',
      '    copy of two:b4',
      'two:b3',
    ]);
  });

  test('a committed duplicate across slots is repaired in document order', () => {
    // As in the repair of a merge, the nodes are created in either order;
    // the block first in document order keeps the id either way. A host's
    // slots come before its children, so the block in the slot wins over
    // the host's own child block.
    const results: string[][] = [];
    for (const slotBlockFirst of [true, false]) {
      using editor = build();
      update(editor, () => {
        // A root container whose children are identified, with a slot.
        const host = $create(SlotContainerNode).append($paragraph('body'));
        $setSlot(host, 'title', $create(SlotContainerNode));
        $getRoot().append(host, $paragraph('after'));
      });
      update(
        editor,
        () => {
          const make = (text: string) => $paragraph(text, 'same');
          const [first, second] = slotBlockFirst
            ? [make('in slot'), make('in host body')]
            : [make('in host body'), make('in slot')];
          const [slotBlock, bodyBlock] = slotBlockFirst
            ? [first, second]
            : [second, first];
          $host(0).splice(0, 0, [bodyBlock]);
          $container(0).append(slotBlock);
        },
        {skipTransforms: true, tag: COLLABORATION_TAG},
      );
      results.push(outline(editor));
    }
    expect(results[0]).toEqual([
      'in host bodybody:b1',
      // The title container is a slot value but not a block; its child is.
      '    in slot:same',
      '  in host body:b4',
      '  body:b2',
      'after:b3',
    ]);
    expect(results[1]).toEqual(results[0]);
  });

  test('a committed duplicate between two slots follows the slot order', () => {
    const results: string[][] = [];
    for (const order of [
      ['caption', 'title'],
      ['title', 'caption'],
    ]) {
      using editor = build();
      update(editor, () => {
        $getRoot().append($paragraph('host'));
      });
      update(
        editor,
        () => {
          // Created (and slotted) in either order.
          for (const name of order) {
            $setSlot($host(0), name, $paragraph(`in ${name}`, 'same'));
          }
        },
        {skipTransforms: true, tag: COLLABORATION_TAG},
      );
      results.push(outline(editor));
    }
    // Slots are kept in a canonical order, so the first one keeps the id on
    // every peer.
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toEqual([
      'host:b1',
      '  in caption:same',
      '  in title:b2',
    ]);
  });

  test('replacing a slot value with $setSlot keeps the id', () => {
    using editor = build();
    update(editor, () => {
      const host = $paragraph('host');
      $getRoot().append(host);
      $setSlot(host, 'caption', $paragraph('old caption'));
    });
    expect(outline(editor)).toEqual(['host:b1', '  old caption:b2']);
    update(editor, () => {
      $setSlot($host(0), 'caption', $createHeadingNode('h2'));
    });
    expect(outline(editor)).toEqual(['host:b1', '  :b2']);
    // Removing the slot and setting a new one in a later update is not a
    // replacement.
    update(editor, () => {
      $removeSlot($host(0), 'caption');
    });
    update(editor, () => {
      $setSlot($host(0), 'caption', $paragraph('new caption'));
    });
    expect(outline(editor)).toEqual(['host:b1', '  new caption:b3']);
  });

  test('a type change inside a slot keeps the id', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append($hostWithSlot('host', ['one', 'two']));
    });
    update(editor, () => {
      const [, two] = $container(0).getChildren();
      assert($isElementNode(two));
      two.select(0, 0);
      $setBlocksType(two.selectStart().clone(), () => $createHeadingNode('h1'));
    });
    editor.read(() => {
      const [, two] = $container(0).getChildren();
      expect(two.getType()).toBe('heading');
    });
    expect(outline(editor)).toEqual(['host:b1', '    one:b2', '    two:b3']);
  });

  test('the index follows a state replaced wholesale (undo) into slots', () => {
    using editor = build({history: true});
    update(editor, () => {
      $getRoot().append($hostWithSlot('host', ['one']));
    });
    update(editor, () => {
      $container(0).append($paragraph('two'));
    });
    expect(outline(editor)).toEqual(['host:b1', '    one:b2', '    two:b3']);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(outline(editor)).toEqual(['host:b1', '    one:b2']);
    editor.read(() => {
      expect($getBlockById('b2')!.getTextContent()).toBe('one');
      expect($getBlockById('b3')).toBe(null);
    });
    // A JSON document loaded with setEditorState is indexed too.
    const json = JSON.stringify(editor.getEditorState().toJSON());
    using other = build();
    other.setEditorState(other.parseEditorState(json));
    other.read(() => {
      expect($getBlockById('b2')!.getTextContent()).toBe('one');
    });
  });

  test('removing a host drops the blocks of its slots from the index', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append($hostWithSlot('host', ['one']), $paragraph('two'));
    });
    update(editor, () => {
      $host(0).remove();
    });
    editor.read(() => {
      expect($getBlockById('b2')).toBe(null);
    });
    // The id is free again: a block given it keeps it.
    update(editor, () => {
      $getRoot().append($paragraph('restored', 'b2'));
    });
    expect(outline(editor)).toEqual(['two:b3', 'restored:b2']);
    editor.read(() => {
      expect($getBlockById('b2')!.getTextContent()).toBe('restored');
    });
  });

  test('while disabled, the lookup scans slots too', () => {
    using editor = build({disabled: true});
    update(editor, () => {
      const host = $hostWithSlot('host', ['one']);
      $getRoot().append(host);
      $setState(host.getLatest(), blockIdState, 'h');
      const container = $getSlot(host, 'title');
      assert($isElementNode(container));
      $setState(container.getFirstChildOrThrow(), blockIdState, 'manual');
    });
    editor.read(() => {
      expect($getBlockById('manual')!.getTextContent()).toBe('one');
    });
    getExtensionDependencyFromEditor(
      editor,
      BlockIdExtension,
    ).output.disabled.value = false;
    expect(outline(editor)).toEqual(['host:h', '    one:manual']);
    editor.read(() => {
      expect($getBlockById('manual')!.getTextContent()).toBe('one');
    });
  });
});
