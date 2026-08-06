import { loadSettings } from "./settings"
import { mockAsk, mockCreateNote, mockGetNotes, mockPatchNote } from "./mock"
import type {
  AskResponse,
  CreateNotePayload,
  Note,
  NotesQuery,
  NotesResponse,
} from "./types"

async function realFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { apiBaseUrl, apiToken } = loadSettings()
  if (!apiBaseUrl) throw new Error("未配置 API Base URL，请到设置页填写或切换到 Mock 模式")
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
      ...init?.headers,
    },
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function getNotes(query: NotesQuery): Promise<NotesResponse> {
  if (loadSettings().useMock) return mockGetNotes(query)
  const params = new URLSearchParams()
  if (query.category) params.set("category", query.category)
  if (query.tag) params.set("tag", query.tag)
  if (query.q) params.set("q", query.q)
  if (query.cursor) params.set("cursor", query.cursor)
  const qs = params.toString()
  return realFetch<NotesResponse>(`/api/notes${qs ? `?${qs}` : ""}`)
}

export async function createNote(payload: CreateNotePayload): Promise<Note> {
  if (loadSettings().useMock) return mockCreateNote(payload)
  return realFetch<Note>("/api/notes", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function patchNote(
  id: string,
  patch: Partial<Pick<Note, "todo_done" | "category" | "tags" | "content">>,
): Promise<Note> {
  if (loadSettings().useMock) return mockPatchNote(id, patch)
  return realFetch<Note>(`/api/notes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
}

export async function ask(question: string): Promise<AskResponse> {
  if (loadSettings().useMock) return mockAsk(question)
  return realFetch<AskResponse>("/api/ask", {
    method: "POST",
    body: JSON.stringify({ question }),
  })
}
