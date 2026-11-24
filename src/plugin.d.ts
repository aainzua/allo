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
      requireCredential?: boolean
    },
    handler: (input: Input) => Result | Promise<Result>,
  ): void
  service(ctx: Context, spec: { name: string; description: string; usage: string }, value: unknown): void
  connection(name: string, options?: { requireCredential?: boolean }): {
    destination: string; credential?: string; credentialEnv?: string; name?: string
  }
  logins: {
    read(name: string, destination: string): Promise<{ email: string; token: string } | null>
    write(name: string, destination: string, email: string, token: string): Promise<void>
    delete(name: string, destination: string): Promise<boolean>
  }
  account(ctx: Context, connection: string, provider: {
    login(email: string, token: string): Promise<unknown>
    status(): Promise<unknown>
    logout(): Promise<unknown>
  }): void
  error(code: string, message: string, details?: unknown): AlloError
}
