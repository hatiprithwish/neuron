import { z } from "zod";
import { ZEntityKind, ZEntityStatus } from "./DomainEnums";

// DEV_NOTE: entities are goals/people/accounts — the shared "named thing to attach entries to"
// across every domain, linked via entry_entities' role-scoped join. Live outside trackers so the
// same entity can be referenced from any number of them. See architecture.md §5 "entities".

// Create Entity Body
export const ZEntityBase = z.object({
  name: z.string(),
  kind: ZEntityKind,
  colorIndex: z.number().nullable().optional(),
  parentPublicId: z.string().nullable().optional(),
  status: ZEntityStatus.nullable().optional(),
  startedOn: z.string().nullable().optional(), // YYYY-MM-DD
  endedOn: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
});
export type EntityBase = z.infer<typeof ZEntityBase>;

// Whole Entity Body — DB shape
// DEV_NOTE: id / parentId are the internal autoincrement PKs — used by DAL/Repo for joins only,
// NEVER sent to a client. parentPublicId is what crosses the API boundary instead.
export const ZEntity = z.object({
  id: z.number(),
  publicId: z.string(),
  userId: z.string(),
  kind: ZEntityKind,
  name: z.string(),
  colorIndex: z.number().nullable(),
  parentId: z.number().nullable(),
  status: ZEntityStatus.nullable(),
  startedOn: z.string().nullable(),
  endedOn: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: z.date(),
  updatedAt: z.date().nullable().optional(),
  archivedAt: z.date().nullable().optional(),
  deletedAt: z.date().nullable().optional(),
});
export type Entity = z.infer<typeof ZEntity>;

// API response shape — id/parentId/deletedAt structurally omitted, publicId is client-facing
export type EntityApiShape = Omit<Entity, "id" | "parentId" | "deletedAt"> & {
  parentPublicId: string | null;
};
