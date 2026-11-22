const maxWorkflowPackageBytes = 2 * 1024 * 1024;
const workflowFileName = /^readypackets-workflows-\d{8}-\d{4}\.json$/u;

export function workflowFileProblem(file: File): string | undefined {
  if (!/\.json$/iu.test(file.name) || (file.type !== "" && file.type !== "application/json")) {
    return "Choose a ReadyPackets workflow package with a .json file extension.";
  }
  if (file.size === 0) return "The workflow package is empty.";
  if (file.size > maxWorkflowPackageBytes) return "The workflow package must be 2 MB or smaller.";
  return undefined;
}

/** The server validates the original text, including depth, duplicate identifiers and integrity. */
export async function readWorkflowFile(file: File): Promise<string> {
  const problem = workflowFileProblem(file);
  if (problem) throw new Error(problem);
  try {
    if (typeof file.text === "function") return await file.text();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Missing file text"));
      reader.onerror = reader.onabort = () => reject(new Error("Failed to read file"));
      reader.readAsText(file);
    });
  } catch {
    throw new Error("The workflow package could not be read. Choose the file again.");
  }
}

export function downloadWorkflowFile(filename: string, json: string): void {
  if (!workflowFileName.test(filename) || !json.length) throw new Error("The workflow download was not valid.");
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
