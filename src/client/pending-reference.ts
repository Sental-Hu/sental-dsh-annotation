import {
  insertAnnotationReference,
  type InputReferenceOccurrence,
  type ReferenceInsert,
  type TokenSpan,
} from "./input-reference.js";
import { inputOffset, orphanedAnnotationLabels } from "../compat/input.js";

interface InputSnapshotLike {
  readonly draft: string;
  readonly draftRev: number;
  readonly occurrences: readonly InputReferenceOccurrence[];
}

interface SessionInputLike {
  readonly state: { getSnapshot(): InputSnapshotLike };
  insertReference(reference: ReferenceInsert, span: TokenSpan): boolean;
}

interface ConversationLike {
  readonly input: { for(scope: SessionScopeLike): SessionInputLike };
}

export interface SessionScopeLike {
  get(name: string, strict?: boolean): unknown;
}

export interface SessionsLike {
  scope(sessionId: string): SessionScopeLike | undefined;
}

export interface AnnotationReferenceTarget {
  readonly id: string;
  readonly sequence: number;
  readonly restoreLabel?: boolean;
}

/** Insert one selected annotation as an independently removable file chip. */
export function createAnnotationReferenceInserter(
  sessions: SessionsLike | undefined,
  sessionId: string,
): ((annotation: AnnotationReferenceTarget) => boolean) | undefined {
  const scope =
    typeof sessions?.scope === "function"
      ? sessions.scope(sessionId)
      : undefined;
  if (!scope) return undefined;
  const conversation = scope.get("conversation") as
    ConversationLike | undefined;
  if (!conversation?.input?.for) return undefined;
  return (annotation) => {
    try {
      const input = conversation.input.for(scope);
      const state = input.state.getSnapshot();
      const request = insertAnnotationReference(
        {
          sessionId,
          draft: state.draft,
          draftRev: state.draftRev,
          occurrences: state.occurrences,
        },
        annotation,
      );
      if (!request) return false;
      let start = state.draft.length;
      let end = start;
      if (annotation.restoreLabel) {
        if (
          orphanedAnnotationLabels(state.draft, state.occurrences).filter(
            (n) => n === annotation.sequence,
          ).length !== 1
        )
          return false;
        const label = `[批注 ${annotation.sequence}]`;
        start = state.draft.indexOf(label);
        end = start + label.length;
      }
      const from = inputOffset(start, state.occurrences);
      const to = inputOffset(end, state.occurrences);
      if (from === undefined || to === undefined) return false;
      return input.insertReference(request.reference, {
        start: from,
        end: to,
        draftRev: state.draftRev,
      });
    } catch {
      return false;
    }
  };
}
