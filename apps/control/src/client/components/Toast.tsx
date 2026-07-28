/** Action feedback. Sits above the tab bar so a thumb never covers it. */

export interface ToastMessage {
  id: number;
  kind: "ok" | "error";
  text: string;
}

interface Props {
  toast: ToastMessage | null;
  onDismiss: () => void;
}

export function Toast({ toast, onDismiss }: Props) {
  if (!toast) return null;
  return (
    <button type="button" className={`toast toast--${toast.kind}`} onClick={onDismiss}>
      {toast.text}
    </button>
  );
}
