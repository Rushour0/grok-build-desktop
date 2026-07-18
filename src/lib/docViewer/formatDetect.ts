export type DocFormat = "pdf" | "docx" | "doc" | "unsupported";

export function detectDocFormat(path: string): DocFormat {
  const pathWithoutSuffix = path.split(/[?#]/, 1)[0];
  const extension = pathWithoutSuffix.slice(pathWithoutSuffix.lastIndexOf(".") + 1).toLowerCase();

  if (extension === "pdf" || extension === "docx" || extension === "doc") {
    return extension;
  }

  return "unsupported";
}
