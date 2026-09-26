import { useForm } from "@tanstack/react-form";
import { Button } from "@/shadcn/ui/button";
import { Input } from "@/shadcn/ui/input";
import { Field, FieldLabel, FieldError } from "@/shadcn/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shadcn/ui/select";
import * as Schemas from "@app/schemas";

// DEV_NOTE: one form for every entity kind — `kind` is the only thing that differs between them.
interface EntityFormProps {
  defaultKind?: Schemas.EntityKind;
  // DEV_NOTE: seeded on the edit path. Kind rides along so the (disabled) select still shows what
  // the entity is — an entity's kind is immutable, see ZUpdateEntityApiRequest for why.
  initialValue?: Schemas.EntityBase;
  lockKind?: boolean;
  onSubmit: (value: Schemas.EntityBase) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

const KIND_LABELS: Record<Schemas.EntityKind, string> = {
  person: "Person",
  goal: "Goal",
  account: "Account",
};

export function EntityForm({
  defaultKind = "goal",
  initialValue,
  lockKind = false,
  onSubmit,
  onCancel,
  submitLabel = "Save",
}: EntityFormProps) {
  const defaultValues: Schemas.EntityBase = initialValue ?? {
    name: "",
    kind: defaultKind,
  };

  const form = useForm({
    defaultValues,
    validators: { onSubmit: Schemas.ZEntityBase },
    onSubmit: async ({ value }) => {
      await onSubmit(value);
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
      className="flex flex-col gap-4"
    >
      <form.Field name="name">
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor={field.name}>Name</FieldLabel>
              <Input
                id={field.name}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                aria-invalid={isInvalid}
              />
              <FieldError errors={field.state.meta.errors} />
            </Field>
          );
        }}
      </form.Field>

      <form.Field name="kind">
        {(field) => (
          <Field>
            <FieldLabel htmlFor={field.name}>Kind</FieldLabel>
            <Select
              value={field.state.value}
              disabled={lockKind}
              onValueChange={(value) => field.handleChange(value as Schemas.EntityKind)}
            >
              <SelectTrigger id={field.name} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(Object.keys(KIND_LABELS) as Schemas.EntityKind[]).map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {lockKind ? (
              <span className="text-xs text-muted-foreground">
                Kind can&apos;t change — past entries are linked to this entity under a role that
                mirrors it. Archive it and create the right one instead.
              </span>
            ) : null}
          </Field>
        )}
      </form.Field>

      <div className="flex gap-2 justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            form.reset();
            onCancel();
          }}
        >
          Cancel
        </Button>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving..." : submitLabel}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
