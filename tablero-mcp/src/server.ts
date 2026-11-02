import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { KINDS, PRIORITIES, ToolError, type Service } from './service.js'

const INSTRUCTIONS = `Tablero is the user's personal Kanban board. Use it to know what is left to build and what is already done.

- Columns are configurable, so their names vary. Each column has a "kind": todo, doing or done. Decide what is pending or finished by kind, not by name.
- Start with list_boards, then list_cards with kind "todo" (and "doing") to see the pending work, highest priority first within each column.
- Read a card with get_card before implementing it: the description holds the acceptance criteria and the comments hold decisions.
- When you start a card, move it to kind "doing". When you finish, move it to kind "done" and add a comment saying what changed (files, branch or commit).
- Create a card with create_card when new work comes up in the conversation. Do not invent board or card ids; take them from the tools.
- You can only act on boards the user is a member of. Nothing here deletes data; archive_card hides a card.`

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })

async function respond(action: () => Promise<unknown>) {
  try {
    return text(await action())
  } catch (error) {
    const message = error instanceof ToolError ? error.message : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
    return { isError: true, content: [{ type: 'text' as const, text: message }] }
  }
}

const boardId = z.string().min(1).describe('Board id from list_boards')
const cardId = z.string().min(1).describe('Card id from list_cards')
const kind = z.enum(KINDS).describe('Column kind: todo, doing or done')
const priority = z.enum(PRIORITIES).describe('Card priority')
const dueDate = z.string().describe('Due date as YYYY-MM-DD')

export function createServer(service: Service) {
  const server = new McpServer({ name: 'tablero', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  const readOnly = { readOnlyHint: true, openWorldHint: false }
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

  server.registerTool(
    'list_boards',
    {
      title: 'List boards',
      description: 'List the boards the user belongs to, with their columns (id, name, kind) and label names.',
      annotations: readOnly,
    },
    () => respond(() => service.listBoards()),
  )

  server.registerTool(
    'get_board',
    {
      title: 'Get board',
      description: 'Board overview: columns with card counts, labels and members (name, email, role).',
      inputSchema: { boardId },
      annotations: readOnly,
    },
    (input) => respond(() => service.getBoard(input)),
  )

  server.registerTool(
    'list_cards',
    {
      title: 'List cards',
      description:
        'List the active (not archived) cards of a board, ordered by column and position. Use kind "todo" or "doing" to see pending work and "done" for what is finished. Descriptions are truncated; use get_card for the full text.',
      inputSchema: {
        boardId,
        kind: kind.optional(),
        columnId: z.string().optional().describe('Only cards in this column'),
        priority: priority.optional(),
        assignee: z.string().optional().describe('Member email or uid'),
      },
      annotations: readOnly,
    },
    (input) => respond(() => service.listCards(input)),
  )

  server.registerTool(
    'get_card',
    {
      title: 'Get card',
      description: 'Full detail of one card: description, comments and recent history.',
      inputSchema: { boardId, cardId },
      annotations: readOnly,
    },
    (input) => respond(() => service.getCard(input)),
  )

  server.registerTool(
    'create_card',
    {
      title: 'Create card',
      description:
        'Create a card at the end of a column. Without columnId or kind it goes to the first "todo" column. Put acceptance criteria in the description.',
      inputSchema: {
        boardId,
        title: z.string().describe('Short title, up to 200 characters'),
        description: z.string().optional().describe('Details and acceptance criteria, up to 5000 characters'),
        columnId: z.string().optional(),
        kind: kind.optional(),
        priority: priority.optional(),
        labels: z.array(z.string()).optional().describe('Label names or ids; they must already exist in the board'),
        assignee: z.string().optional().describe('Member email or uid'),
        dueDate: dueDate.optional(),
      },
      annotations: write,
    },
    (input) => respond(() => service.createCard(input)),
  )

  server.registerTool(
    'update_card',
    {
      title: 'Update card',
      description:
        'Change fields of a card. Only the fields you pass change. labels replaces the whole set. Pass null for assignee or dueDate to clear them. Use move_card to change the column.',
      inputSchema: {
        boardId,
        cardId,
        title: z.string().optional(),
        description: z.string().optional(),
        priority: priority.optional(),
        labels: z.array(z.string()).optional().describe('Label names or ids; replaces the current labels'),
        assignee: z.string().nullable().optional().describe('Member email or uid, or null to clear'),
        dueDate: dueDate.nullable().optional(),
      },
      annotations: { ...write, idempotentHint: true },
    },
    (input) => respond(() => service.updateCard(input)),
  )

  server.registerTool(
    'move_card',
    {
      title: 'Move card',
      description:
        'Move a card to another column, by columnId or by kind (the first column of that kind). It goes to the end of the column unless position is "start". Move to "doing" when you start work and to "done" when you finish.',
      inputSchema: {
        boardId,
        cardId,
        columnId: z.string().optional(),
        kind: kind.optional(),
        position: z.enum(['start', 'end']).optional(),
      },
      annotations: { ...write, idempotentHint: true },
    },
    (input) => respond(() => service.moveCard(input)),
  )

  server.registerTool(
    'add_comment',
    {
      title: 'Add comment',
      description: 'Add a comment to a card, for example what was done and in which commit. It appears under the user name, and the card history marks it as done via Claude.',
      inputSchema: { boardId, cardId, text: z.string().describe('Comment text, up to 2000 characters') },
      annotations: write,
    },
    (input) => respond(() => service.addComment(input)),
  )

  server.registerTool(
    'archive_card',
    {
      title: 'Archive card',
      description: 'Archive a card so it leaves the board. Nothing is deleted.',
      inputSchema: { boardId, cardId },
      annotations: write,
    },
    (input) => respond(() => service.archiveCard(input)),
  )

  return server
}
