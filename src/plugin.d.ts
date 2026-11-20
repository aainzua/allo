import type { Context } from 'cordis'

export class AlloError extends Error {
  readonly code: string
  readonly details?: unknown
  constructor(code: string, message: string, details?: unknown)
}

export interface Allo {
  operation<Input, Result>(
    ctx: Context,
    spec: {
      name: string
      description: string
      inputSchema: object | boolean
      resultSchema: object | boolean
      connections?: string[]
    },
    handler: (input: Input) => Result | Promise<Result>,
  ): void
  service(ctx: Context, spec: { name: string; description: string; usage: string }, value: unknown): void
  connection(name: string): { destination: string; credential?: string }
  error(code: string, message: string, details?: unknown): AlloError
}
