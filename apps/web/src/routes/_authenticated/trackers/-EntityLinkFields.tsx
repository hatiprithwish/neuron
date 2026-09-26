import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shadcn/ui/select";
import { Field, FieldLabel } from "@/shadcn/ui/field";
import { Button } from "@/shadcn/ui/button";
import type * as Schemas from "@app/schemas";
import { EntitiesQueries } from "../entities/-data";

// DEV_NOTE: every entry_role is also an entity_kind (architecture.md §3), so "which entity" and
// "in which role" are one choice, not two — an account entity can only ever be linked as role
// "account". One select per role is also what enforces invariant 6 at the UI level: exactly one
// entity per role per entry, so a slice-by-role donut always sums to 100%.
const ROLE_LABELS: Record<Schemas.EntryRole, string> = {
  person: "Person",
  account: "Account",
};

const NONE_VALUE = "__none__";

interface EntityLinkFieldsProps {
  value: Schemas.EntityLinkInput[];
  onChange: (links: Schemas.EntityLinkInput[]) => void;
  roles?: Schemas.EntryRole[];
  // DEV_NOTE: quick-add widgets pass nothing and get the collapsed affordance — a Today screen with
  // five trackers should not be a wall of dropdowns. Full-page forms pass `alwaysOpen` because
  // attribution is part of what they're there to capture.
  alwaysOpen?: boolean;
}

export function EntityLinkFields({ value, onChange, roles, alwaysOpen }: EntityLinkFieldsProps) {
  const { getToken } = useAuth();
  const [isOpen, setIsOpen] = useState(false);

  // DEV_NOTE: one fixed query per role rather than a loop — hook order has to be stable, and
  // TanStack caches each kind's list app-wide, so a second form on the same page pays nothing.
  const people = useQuery(EntitiesQueries.list("person", getToken));
  const accounts = useQuery(EntitiesQueries.list("account", getToken));

  const byRole: Record<Schemas.EntryRole, Schemas.EntityApiShape[]> = {
    person: people.data?.entities ?? [],
    account: accounts.data?.entities ?? [],
  };

  const visibleRoles = (roles ?? (Object.keys(ROLE_LABELS) as Schemas.EntryRole[])).filter(
    (role) => byRole[role].length > 0,
  );

  if (visibleRoles.length === 0) return null;

  const setLink = (role: Schemas.EntryRole, entityPublicId: string) => {
    const withoutRole = value.filter((link) => link.role !== role);
    onChange(
      entityPublicId === NONE_VALUE ? withoutRole : [...withoutRole, { role, entityPublicId }],
    );
  };

  const summary = visibleRoles
    .flatMap((role) => {
      const linked = value.find((link) => link.role === role);
      if (!linked) return [];
      const entity = byRole[role].find((candidate) => candidate.publicId === linked.entityPublicId);
      return entity ? [`${ROLE_LABELS[role]}: ${entity.name}`] : [];
    })
    .join(" · ");

  if (!alwaysOpen && !isOpen) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto self-start p-0 text-xs text-muted-foreground hover:bg-transparent hover:underline"
        onClick={() => setIsOpen(true)}
      >
        {summary === "" ? "+ Attribute to an entity" : `${summary} — change`}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {visibleRoles.map((role) => {
        const selected = value.find((link) => link.role === role)?.entityPublicId ?? NONE_VALUE;
        return (
          <Field key={role}>
            <FieldLabel htmlFor={`link-${role}`}>{ROLE_LABELS[role]}</FieldLabel>
            <Select value={selected} onValueChange={(next) => setLink(role, next)}>
              <SelectTrigger id={`link-${role}`} className="w-full">
                <SelectValue placeholder={`Choose a ${ROLE_LABELS[role].toLowerCase()}`} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={NONE_VALUE}>None</SelectItem>
                  {byRole[role]
                    .filter((entity) => !entity.archivedAt)
                    .map((entity) => (
                      <SelectItem key={entity.publicId} value={entity.publicId}>
                        {entity.name}
                      </SelectItem>
                    ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        );
      })}

      {alwaysOpen ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto self-start p-0 text-xs text-muted-foreground hover:bg-transparent hover:underline"
          onClick={() => setIsOpen(false)}
        >
          Done
        </Button>
      )}
    </div>
  );
}
