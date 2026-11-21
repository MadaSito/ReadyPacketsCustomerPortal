export interface EditorVariable {
  name: string;
  label: string;
  required?: boolean;
}

export interface RichTextEditorProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Id of the editable element. */
  id?: string;
  /** HTML in the e-mail subset (variables as the literal text `{{name}}`). */
  value: string;
  onChange: (html: string) => void;
  /** Palette for "Insert variable"; inserted as chips. */
  variables?: EditorVariable[];
  disabled?: boolean;
}
