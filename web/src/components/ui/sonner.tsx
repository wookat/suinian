import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleAlert, CircleCheck, Info, Loader2, TriangleAlert } from "lucide-react"

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      position="bottom-center"
      offset={{ bottom: 88 }}
      mobileOffset={{ bottom: 96 }}
      duration={4000}
      closeButton={false}
      icons={{
        success: <CircleCheck className="size-4 text-success" />,
        info: <Info className="size-4 text-info" />,
        warning: <TriangleAlert className="size-4 text-warning" />,
        error: <CircleAlert className="size-4 text-destructive" />,
        loading: <Loader2 className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "group toast !rounded-xl !border !border-border !bg-popover !text-popover-foreground !shadow-lg !text-sm !gap-2.5 !items-center",
          description: "!text-muted-foreground",
          actionButton:
            "!bg-transparent !text-primary !font-medium hover:!underline !px-1 !h-auto !text-sm",
          cancelButton: "!bg-secondary !text-secondary-foreground !text-xs",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
