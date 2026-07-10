import type { InteractiveCardKind } from "./interactive-card-registry.js"

export interface EmbeddedInteraction {
  requestId: string
  kind: InteractiveCardKind
  resolve(selections?: readonly string[]): Promise<void>
}

export interface EmbeddedInteractionRegistry {
  register(interaction: EmbeddedInteraction): void
  get(kind: InteractiveCardKind, requestId: string): EmbeddedInteraction | undefined
  untrack(kind: InteractiveCardKind, requestId: string): boolean
  list(): EmbeddedInteraction[]
}

export function createEmbeddedInteractionRegistry(): EmbeddedInteractionRegistry {
  const interactions = new Map<string, EmbeddedInteraction>()
  return {
    register(interaction) {
      interactions.set(key(interaction.kind, interaction.requestId), interaction)
    },
    get(kind, requestId) {
      return interactions.get(key(kind, requestId))
    },
    untrack(kind, requestId) {
      return interactions.delete(key(kind, requestId))
    },
    list() {
      return [...interactions.values()]
    },
  }
}

function key(kind: InteractiveCardKind, requestId: string): string {
  return `${kind}:${requestId}`
}
