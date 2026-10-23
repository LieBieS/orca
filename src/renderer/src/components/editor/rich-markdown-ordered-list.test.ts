// @vitest-environment happy-dom
import { Editor, type Content } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function withEditor(content: Content, markdown: boolean, run: (editor: Editor) => void): void {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content:
      markdown && typeof content === 'string'
        ? encodeRawMarkdownHtmlForRichEditor(content, codec)
        : content,
    ...(markdown ? { contentType: 'markdown' as const } : {})
  })
  try {
    run(editor)
  } finally {
    editor.destroy()
  }
}

function orderedListCount(editor: Editor): number {
  return JSON.stringify(editor.getJSON()).match(/"type":"orderedList"/g)?.length ?? 0
}

describe('rich markdown ordered list markers', () => {
  it.each([
    'Mr. Smith came back.\n\nDr. Jones looked at him.\n\nSt. Louis was a long way off.',
    'A. Smith wrote back.\n\nOK. That works.\n\niv. is not a list here.\n\nI. said so.',
    '> a. first\n> continued'
  ])('keeps %j as prose when opened and saved', (source) => {
    withEditor(source, true, (editor) => {
      expect(orderedListCount(editor)).toBe(0)
      expect(editor.getMarkdown()).toBe(source)
    })
  })

  it.each([
    ['1. one\n2. two\n\nDr. Smith said.', 1],
    ['1. one\nDr. Smith said.', 1],
    ['3. three\n4. four', 1],
    ['1. parent\n   1. child\n   2. child two\n2. sibling', 2],
    ['1. [ ] task\n2. [x] done', 1]
  ] as const)('round-trips numeric list %j unchanged', (source, lists) => {
    withEditor(source, true, (editor) => {
      expect(orderedListCount(editor)).toBe(lists)
      expect(editor.getMarkdown()).toBe(source)
    })
  })

  it('saves a lettered list pasted as HTML with numeric markers', () => {
    withEditor(
      '<ol type="a" start="2"><li><p>x</p></li><li><p>y</p></li></ol>',
      false,
      (editor) => {
        expect(editor.getMarkdown()).toBe('2. x\n3. y')
      }
    )
  })
})
