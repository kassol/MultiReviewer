import { cn } from "@/lib/utils";

const WIDTH = {
  wide: "max-w-[1180px]",
  form: "max-w-[1060px]",
} as const;

export function PageBody({
  width = "wide",
  className,
  ...props
}: React.ComponentProps<"div"> & { width?: keyof typeof WIDTH }) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-5 p-4 pb-20 sm:p-5 sm:pb-20",
        WIDTH[width],
        className,
      )}
      {...props}
    />
  );
}
