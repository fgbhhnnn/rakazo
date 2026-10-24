import { type FileIcon, fileKindOf } from "@rakazo/chat-ui/file-kinds";
import {
  File,
  FileArchive,
  FileAudio,
  FileBraces,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Globe,
  type LucideIcon,
  Presentation,
} from "lucide-react";

const ICONS: Record<FileIcon, LucideIcon> = {
  pdf: FileText,
  sheet: FileSpreadsheet,
  doc: FileType,
  slides: Presentation,
  text: FileText,
  markdown: FileText,
  json: FileBraces,
  html: Globe,
  archive: FileArchive,
  code: FileCode,
  audio: FileAudio,
  video: FileVideo,
  image: FileImage,
  file: File,
};

type FileRef = { name?: string | null; mimeType?: string | null };

/** The file's type icon in its color, with the colored type badge (PDF, XLSX, …) over its corner. */
export function FileKindIcon({ size = 40, ...file }: FileRef & { size?: number }) {
  const kind = fileKindOf(file);
  const Icon = ICONS[kind.icon];
  return (
    <span
      data-file-kind={kind.icon}
      className="relative grid shrink-0 place-items-center rounded-[10px]"
      style={{ width: size, height: size, backgroundColor: `${kind.color}1f`, color: kind.color }}
    >
      <Icon size={Math.round(size * 0.52)} strokeWidth={1.8} aria-hidden />
      {size >= 28 ? (
        <span
          className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-[4px] px-1 text-[9px] leading-[13px] font-bold tracking-wide text-white"
          style={{ backgroundColor: kind.color }}
        >
          {kind.badge}
        </span>
      ) : null}
    </span>
  );
}

/** Just the colored type badge, for rows that already show an icon. */
export function FileKindBadge(file: FileRef) {
  const kind = fileKindOf(file);
  return (
    <span
      className="rounded-md px-2 py-1 text-[11px] font-semibold text-white"
      style={{ backgroundColor: kind.color }}
    >
      {kind.badge}
    </span>
  );
}
