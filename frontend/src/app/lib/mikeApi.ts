/**
 * Mike API client — all requests to the Node.js backend.
 * Attaches the Supabase auth token for user authentication.
 */

import { supabase } from "@/lib/supabase";
import type {
    AssistantEvent,
    Chat,
    ChatDetailOut,
    CitationAnnotation,
    Document,
    Folder,
    Message,
    Project,
    Workflow,
    TabularReview,
    TabularReviewDetailOut,
} from "@/app/components/shared/types";

// Server-side shape before mapping
interface ServerMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: { filename: string; document_id?: string }[] | null;
    workflow?: { id: string; title: string } | null;
    annotations?: CitationAnnotation[] | null;
    created_at: string;
}
interface ServerChatDetailOut {
    chat: Chat;
    messages: ServerMessage[];
}

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

export class MikeApiError extends Error {
    status: number;
    code: string | null;
    details: Record<string, unknown> | null;

    constructor(args: {
        message: string;
        status: number;
        code?: string | null;
        details?: Record<string, unknown> | null;
    }) {
        super(args.message);
        this.name = "MikeApiError";
        this.status = args.status;
        this.code = args.code ?? null;
        this.details = args.details ?? null;
    }
}

export class OutboundReleaseCancelled extends Error {
    readonly causeError: MikeApiError;

    constructor(causeError: MikeApiError) {
        super("Release cancelled.");
        this.name = "OutboundReleaseCancelled";
        this.causeError = causeError;
    }
}

export function isMfaRequiredError(error: unknown) {
    return (
        error instanceof MikeApiError &&
        error.status === 403 &&
        error.code === "mfa_verification_required"
    );
}

async function getAuthHeader(): Promise<Record<string, string>> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return {};
    return { Authorization: `Bearer ${session.access_token}` };
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const authHeaders = await getAuthHeader();
    const { headers: initHeaders, ...restInit } = init ?? {};
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...restInit,
        headers: {
            Accept: "application/json",
            ...authHeaders,
            ...(initHeaders as Record<string, string> | undefined),
        },
    });

    if (!response.ok) {
        throw await toApiError(response, path);
    }

    if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
    ) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

async function apiBlobRequest(path: string): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    const authHeaders = await getAuthHeader();
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        headers: {
            Accept: "application/json",
            ...authHeaders,
        },
    });

    if (!response.ok) {
        throw await toApiError(response, path);
    }

    const disposition = response.headers.get("content-disposition") ?? "";
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    return {
        blob: await response.blob(),
        filename: filenameMatch?.[1] ?? null,
    };
}

export async function toApiError(response: Response, path: string) {
    const text = await response.text();
    try {
        const parsed = JSON.parse(text) as unknown;
        const body =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : null;
        devLog("[mike-api] non-ok response", {
            path,
            status: response.status,
            code: body?.code,
            detail: body?.detail,
        });
        return new MikeApiError({
            status: response.status,
            code: body && typeof body.code === "string" ? body.code : null,
            details: body,
            message:
                body && typeof body.detail === "string" && body.detail
                    ? body.detail
                    : `API error: ${response.status}`,
        });
    } catch {
        devLog("[mike-api] non-ok non-json response", {
            path,
            status: response.status,
            bodyPreview: text.slice(0, 200),
        });
        return new MikeApiError({
            status: response.status,
            message: text || `API error: ${response.status}`,
        });
    }
}

export function isTrackedChangesConfirmationRequired(
    error: unknown,
): error is MikeApiError {
    return (
        error instanceof MikeApiError &&
        error.status === 428 &&
        error.code === "outbound_tracked_changes_needs_confirmation"
    );
}

export function isOpenCommentsBlocked(error: unknown): error is MikeApiError {
    return (
        error instanceof MikeApiError &&
        error.status === 422 &&
        error.code === "outbound_open_comments_blocked"
    );
}

export type OutboundReleaseFlags = {
    confirmTrackedChanges: boolean;
    allowOpenComments: boolean;
};

function reviewCount(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function trackedChangesConfirmPrompt(error: MikeApiError): string {
    const counts = error.details?.counts;
    const countRecord =
        counts && typeof counts === "object"
            ? (counts as Record<string, unknown>)
            : null;
    const total = reviewCount(countRecord?.total) ?? 0;
    const insertions = reviewCount(countRecord?.insertions) ?? 0;
    const deletions = reviewCount(countRecord?.deletions) ?? 0;
    const documents = Array.isArray(error.details?.documents)
        ? error.details.documents
        : [];
    const named = documents
        .map((doc) => {
            if (!doc || typeof doc !== "object") return null;
            const row = doc as Record<string, unknown>;
            const filename =
                typeof row.filename === "string" ? row.filename : "document";
            const docCounts =
                row.counts && typeof row.counts === "object"
                    ? (row.counts as Record<string, unknown>)
                    : null;
            const docTotal = reviewCount(docCounts?.total);
            return docTotal == null ? filename : `${filename} (${docTotal})`;
        })
        .filter((name): name is string => !!name);
    const subject =
        named.length > 0
            ? `This download has ${total} open tracked changes (${insertions} insertions, ${deletions} deletions) in ${named.join(", ")}`
            : `This document has ${total} open tracked changes (${insertions} insertions, ${deletions} deletions)`;
    return `${subject}. Release it with tracked changes?`;
}

export function outboundReviewErrorMessage(error: unknown): string {
    if (error instanceof OutboundReleaseCancelled) return "Release cancelled.";
    if (
        error instanceof MikeApiError &&
        error.code === "outbound_open_comments_blocked"
    ) {
        const count = reviewCount(error.details?.count);
        const documents = Array.isArray(error.details?.documents)
            ? error.details.documents
                  .map((doc) => {
                      if (!doc || typeof doc !== "object") return null;
                      const filename = (doc as Record<string, unknown>).filename;
                      return typeof filename === "string" ? filename : null;
                  })
                  .filter((name): name is string => !!name)
            : [];
        if (count != null) {
            const noun = count === 1 ? "comment" : "comments";
            const where =
                documents.length > 0 ? ` in ${documents.join(", ")}` : "";
            return `Export blocked: ${count} open ${noun}${where}. Nothing was downloaded or sent.`;
        }
    }
    return error instanceof Error && error.message
        ? error.message
        : "Export blocked.";
}

export function alertOutboundFailure(error: unknown): void {
    if (error instanceof OutboundReleaseCancelled) return;
    window.alert(outboundReviewErrorMessage(error));
}

export async function confirmOutboundRelease<T>(
    attempt: (flags: OutboundReleaseFlags) => Promise<T>,
): Promise<T> {
    // Flags live only for this call. Nothing is written to storage.
    const flags: OutboundReleaseFlags = {
        confirmTrackedChanges: false,
        allowOpenComments: false,
    };
    for (;;) {
        try {
            return await attempt(flags);
        } catch (error) {
            if (!flags.allowOpenComments && isOpenCommentsBlocked(error)) {
                const accepted = await askSendWithComments(
                    openCommentCount(error),
                    openCommentFilenames(error),
                );
                if (!accepted) throw new OutboundReleaseCancelled(error);
                flags.allowOpenComments = true;
                continue;
            }
            if (
                !flags.confirmTrackedChanges &&
                isTrackedChangesConfirmationRequired(error)
            ) {
                const accepted =
                    typeof window !== "undefined" &&
                    typeof window.confirm === "function" &&
                    window.confirm(trackedChangesConfirmPrompt(error));
                if (!accepted) throw new OutboundReleaseCancelled(error);
                flags.confirmTrackedChanges = true;
                continue;
            }
            throw error;
        }
    }
}

function openCommentCount(error: MikeApiError): number {
    const count = reviewCount(error.details?.count);
    if (count != null) return count;
    return Array.isArray(error.details?.comments)
        ? error.details.comments.length
        : 0;
}

function openCommentFilenames(error: MikeApiError): string[] {
    if (!Array.isArray(error.details?.documents)) return [];
    return error.details.documents
        .map((doc) => {
            if (!doc || typeof doc !== "object") return null;
            const filename = (doc as Record<string, unknown>).filename;
            return typeof filename === "string" && filename.trim()
                ? filename
                : null;
        })
        .filter((name): name is string => !!name);
}

let commentsDialogQueue: Promise<unknown> = Promise.resolve();

/**
 * One-shot dialog. Cancel is focused. The choice is not remembered.
 */
function askSendWithComments(
    count: number,
    filenames: string[],
): Promise<boolean> {
    if (typeof document === "undefined") return Promise.resolve(false);
    const run = commentsDialogQueue.then(() =>
        openSendWithCommentsDialog(count, filenames),
    );
    commentsDialogQueue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

function openSendWithCommentsDialog(
    count: number,
    filenames: string[],
): Promise<boolean> {
    return new Promise((resolve) => {
        const dialog = document.createElement("dialog");
        const titleId = `outbound-comments-title-${Date.now()}`;
        const bodyId = `outbound-comments-body-${Date.now()}`;
        dialog.dataset.outboundDialog = "open-comments";
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-labelledby", titleId);
        dialog.setAttribute("aria-describedby", bodyId);
        Object.assign(dialog.style, {
            border: "none",
            borderRadius: "16px",
            padding: "0",
            maxWidth: "32rem",
            width: "calc(100% - 2rem)",
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        });
        const backdrop = document.createElement("style");
        backdrop.textContent = `dialog[data-outbound-dialog="open-comments"]::backdrop{background:rgba(0,0,0,0.4)}dialog[data-outbound-dialog="open-comments"] button:focus{outline:2px solid #1d4ed8;outline-offset:2px}`;

        const panel = document.createElement("div");
        Object.assign(panel.style, { padding: "28px 28px 24px" });

        const title = document.createElement("h2");
        title.id = titleId;
        title.textContent = "Open comments";
        Object.assign(title.style, {
            margin: "0 0 12px",
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: "28px",
            fontWeight: "400",
            color: "#111827",
        });

        const noun = count === 1 ? "comment" : "comments";
        const where =
            filenames.length > 0 ? ` in ${filenames.join(", ")}` : "";
        const body = document.createElement("p");
        body.id = bodyId;
        body.textContent = `This download has ${count} open ${noun}${where}. A negotiation copy keeps those comments for the counterparty. This choice applies only to this download.`;
        Object.assign(body.style, {
            margin: "0 0 20px",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            fontSize: "14px",
            lineHeight: "1.5",
            color: "#4b5563",
        });

        const actions = document.createElement("div");
        Object.assign(actions.style, {
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            flexWrap: "wrap",
        });

        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.autofocus = true;
        cancel.dataset.defaultFocus = "true";
        styleDialogButton(cancel, false);

        const send = document.createElement("button");
        send.type = "button";
        send.textContent = "Send with comments (negotiation copy)";
        styleDialogButton(send, true);

        actions.append(cancel, send);
        panel.append(title, body, actions);
        dialog.append(backdrop, panel);

        let settled = false;
        const finish = (accepted: boolean) => {
            if (settled) return;
            settled = true;
            dialog.close();
            dialog.remove();
            resolve(accepted);
        };
        cancel.addEventListener("click", () => finish(false));
        send.addEventListener("click", () => finish(true));
        dialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            finish(false);
        });

        dialog.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" || event.target !== dialog) return;
            event.preventDefault();
            finish(false);
        });

        try {
            document.body.appendChild(dialog);
            dialog.showModal();
            cancel.focus();
            queueMicrotask(() => {
                if (!settled) cancel.focus();
            });
        } catch {
            dialog.remove();
            resolve(false);
        }
    });
}

function styleDialogButton(button: HTMLButtonElement, primary: boolean) {
    Object.assign(button.style, {
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        fontSize: "13px",
        fontWeight: "600",
        padding: "8px 14px",
        borderRadius: "8px",
        cursor: "pointer",
        border: primary ? "1px solid #111827" : "1px solid #d1d5db",
        background: primary ? "#111827" : "#ffffff",
        color: primary ? "#ffffff" : "#111827",
    });
}

function withReleaseFlags(path: string, flags: OutboundReleaseFlags): string {
    const splitAt = path.indexOf("?");
    const base = splitAt >= 0 ? path.slice(0, splitAt) : path;
    const params = new URLSearchParams(splitAt >= 0 ? path.slice(splitAt + 1) : "");
    if (flags.confirmTrackedChanges) params.set("confirm_tracked_changes", "1");
    if (flags.allowOpenComments) params.set("allow_open_comments", "1");
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
}

function releaseHeaders(flags: OutboundReleaseFlags): Record<string, string> {
    const headers: Record<string, string> = {};
    if (flags.confirmTrackedChanges) {
        headers["X-Confirm-Tracked-Changes"] = "1";
    }
    if (flags.allowOpenComments) headers["X-Allow-Open-Comments"] = "1";
    return headers;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
    return apiRequest<Project[]>("/projects");
}

export async function createProject(
    name: string,
    cm_number?: string,
    shared_with?: string[],
): Promise<Project> {
    return apiRequest<Project>("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cm_number, shared_with }),
    });
}

export async function deleteAccount(): Promise<void> {
    return apiRequest<void>("/user/account", { method: "DELETE" });
}

export async function deleteAllChats(): Promise<void> {
    return apiRequest<void>("/user/chats", { method: "DELETE" });
}

export async function deleteAllProjects(): Promise<void> {
    return apiRequest<void>("/user/projects", { method: "DELETE" });
}

export async function deleteAllTabularReviews(): Promise<void> {
    return apiRequest<void>("/user/tabular-reviews", { method: "DELETE" });
}

export async function exportAccountData(): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest("/user/export");
}

export async function exportChatData(): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest("/user/chats/export");
}

export async function exportTabularReviewsData(): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest("/user/tabular-reviews/export");
}

export interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    titleModel: string;
    tabularModel: string;
    mfaOnLogin: boolean;
    legalResearchUs: boolean;
    /** True when the backend process has SPONSOR_CI_MODE on. */
    sponsorCiMode?: boolean;
    apiKeyStatus: ApiKeyStatus;
}

export async function getUserProfile(): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile");
}

export async function updateUserProfile(payload: {
    displayName?: string | null;
    organisation?: string | null;
    titleModel?: string;
    tabularModel?: string;
    legalResearchUs?: boolean;
}): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateUserMfaOnLogin(
    enabled: boolean,
): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/security/mfa-login", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
}

export type ApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "openrouter"
    | "courtlistener"
    | "xai"
    | "deepseek";
export type ApiKeySource = "user" | "env" | null;
export type ApiKeyState = Record<
    ApiKeyProvider,
    {
        configured: boolean;
        source: ApiKeySource;
    }
>;

export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources?: Partial<Record<ApiKeyProvider, ApiKeySource>>;
};

export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
    return apiRequest<ApiKeyStatus>("/user/api-keys");
}

export async function saveApiKey(
    provider: ApiKeyProvider,
    apiKey: string | null,
): Promise<ApiKeyStatus> {
    return apiRequest<ApiKeyStatus>(`/user/api-keys/${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
    });
}

export interface McpToolSummary {
    id: string;
    toolName: string;
    openaiToolName: string;
    title: string | null;
    description: string | null;
    enabled: boolean;
    readOnly: boolean;
    destructive: boolean;
    requiresConfirmation: boolean;
    lastSeenAt: string;
}

export interface McpConnectorSummary {
    id: string;
    name: string;
    transport: "streamable_http";
    serverUrl: string;
    authType: "none" | "bearer" | "oauth";
    enabled: boolean;
    hasAuthConfig: boolean;
    customHeaderKeys: string[];
    oauthConnected: boolean;
    toolPolicy: Record<string, unknown>;
    tools: McpToolSummary[];
    toolCount: number;
    createdAt: string;
    updatedAt: string;
}

export async function listMcpConnectors(): Promise<McpConnectorSummary[]> {
    return apiRequest<McpConnectorSummary[]>("/user/mcp-connectors");
}

export async function getMcpConnector(
    connectorId: string,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}`,
    );
}

export async function createMcpConnector(payload: {
    name: string;
    serverUrl: string;
    bearerToken?: string | null;
    headers?: Record<string, string>;
}): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>("/user/mcp-connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateMcpConnector(
    connectorId: string,
    payload: {
        name?: string;
        serverUrl?: string;
        enabled?: boolean;
        bearerToken?: string | null;
        headers?: Record<string, string>;
    },
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function deleteMcpConnector(connectorId: string): Promise<void> {
    return apiRequest<void>(`/user/mcp-connectors/${connectorId}`, {
        method: "DELETE",
    });
}

export async function refreshMcpConnectorTools(
    connectorId: string,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}/refresh-tools`,
        { method: "POST" },
    );
}

export async function startMcpConnectorOAuth(
    connectorId: string,
): Promise<{ authorizationUrl: string | null; alreadyAuthorized: boolean }> {
    return apiRequest<{ authorizationUrl: string | null; alreadyAuthorized: boolean }>(
        `/user/mcp-connectors/${connectorId}/oauth/start`,
        { method: "POST" },
    );
}

export async function setMcpToolEnabled(
    connectorId: string,
    toolId: string,
    enabled: boolean,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}/tools/${toolId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        },
    );
}

export async function getProject(projectId: string): Promise<Project> {
    return apiRequest<Project>(`/projects/${projectId}`);
}

export async function updateProject(
    projectId: string,
    payload: {
        name?: string;
        cm_number?: string;
        shared_with?: string[];
    },
): Promise<Project> {
    return apiRequest<Project>(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteProject(projectId: string): Promise<void> {
    await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

export interface ProjectPeople {
    owner: {
        user_id: string;
        email: string | null;
        display_name: string | null;
    };
    members: { email: string; display_name: string | null }[];
}

export async function getProjectPeople(
    projectId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
    projectId: string,
    name: string,
    parentFolderId?: string | null,
): Promise<Folder> {
    return apiRequest<Folder>(`/projects/${projectId}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function renameProjectFolder(
    projectId: string,
    folderId: string,
    name: string,
): Promise<Folder> {
    return apiRequest<Folder>(
        `/projects/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        },
    );
}

export async function deleteProjectFolder(
    projectId: string,
    folderId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
        method: "DELETE",
    });
}

export async function moveSubfolderToFolder(
    projectId: string,
    folderId: string,
    parentFolderId: string | null,
): Promise<Folder> {
    return apiRequest<Folder>(
        `/projects/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent_folder_id: parentFolderId }),
        },
    );
}

export async function moveDocumentToFolder(
    projectId: string,
    documentId: string,
    folderId: string | null,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function renameProjectDocument(
    projectId: string,
    documentId: string,
    filename: string,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename }),
        },
    );
}

export async function addDocumentToProject(
    projectId: string,
    documentId: string,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}`,
        { method: "POST" },
    );
}

export interface DocumentVersion {
    id: string;
    version_number: number | null;
    source: string;
    created_at: string;
    filename: string | null;
    file_type?: string | null;
    size_bytes?: number | null;
    page_count?: number | null;
    deleted_at?: string | null;
    deleted_by?: string | null;
}

export async function listDocumentVersions(documentId: string): Promise<{
    current_version_id: string | null;
    versions: DocumentVersion[];
}> {
    return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
    documentId: string,
    file: File,
    filename?: string,
): Promise<DocumentVersion> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    if (filename) form.append("filename", filename);
    const response = await fetch(
        `${API_BASE}/single-documents/${documentId}/versions`,
        {
            method: "POST",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<DocumentVersion>;
}

export async function replaceDocumentVersionFile(
    documentId: string,
    versionId: string,
    file: File,
    filename?: string,
): Promise<DocumentVersion> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    if (filename) form.append("filename", filename);
    const response = await fetch(
        `${API_BASE}/single-documents/${documentId}/versions/${versionId}/file`,
        {
            method: "PUT",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<DocumentVersion>;
}

export async function copyDocumentVersionFromDocument(
    documentId: string,
    sourceDocumentId: string,
    filename?: string,
): Promise<DocumentVersion> {
    return apiRequest<DocumentVersion>(
        `/single-documents/${documentId}/versions/from-document`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_document_id: sourceDocumentId,
                filename,
            }),
        },
    );
}

export async function renameDocumentVersion(
    documentId: string,
    versionId: string,
    filename: string | null,
): Promise<DocumentVersion> {
    return apiRequest<DocumentVersion>(
        `/single-documents/${documentId}/versions/${versionId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename }),
        },
    );
}

export async function deleteDocumentVersion(
    documentId: string,
    versionId: string,
): Promise<{
    deleted_version_id: string;
    current_version_id: string | null;
}> {
    return apiRequest(`/single-documents/${documentId}/versions/${versionId}`, {
        method: "DELETE",
    });
}

export async function uploadProjectDocument(
    projectId: string,
    file: File,
): Promise<Document> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(
        `${API_BASE}/projects/${projectId}/documents`,
        {
            method: "POST",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<Document>;
}

export async function uploadStandaloneDocument(
    file: File,
): Promise<Document> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`${API_BASE}/single-documents`, {
        method: "POST",
        headers: { ...authHeaders },
        body: form,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<Document>;
}

export async function listStandaloneDocuments(): Promise<Document[]> {
    return apiRequest<Document[]>("/single-documents");
}

export async function deleteDocument(documentId: string): Promise<void> {
    await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export async function getDocumentUrl(
    documentId: string,
    versionId?: string | null,
    options?: Partial<OutboundReleaseFlags>,
): Promise<{ url: string; filename: string; version_id: string | null }> {
    const flags: OutboundReleaseFlags = {
        confirmTrackedChanges: !!options?.confirmTrackedChanges,
        allowOpenComments: !!options?.allowOpenComments,
    };
    const params = new URLSearchParams();
    if (versionId) params.set("version_id", versionId);
    if (flags.confirmTrackedChanges) params.set("confirm_tracked_changes", "1");
    if (flags.allowOpenComments) params.set("allow_open_comments", "1");
    const qs = params.toString();
    return apiRequest(
        `/single-documents/${documentId}/url${qs ? `?${qs}` : ""}`,
        { headers: releaseHeaders(flags) },
    );
}

/**
 * No screen currently calls `/url`. This helper is the confirm flow for
 * that route: 428 prompts, then retries with the confirm flag.
 */
export async function getDocumentUrlWithConfirm(
    documentId: string,
    versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
    return confirmOutboundRelease((flags) =>
        getDocumentUrl(documentId, versionId, flags),
    );
}

async function requestDocumentsZip(
    documentIds: string[],
    flags: OutboundReleaseFlags,
): Promise<Blob> {
    const authHeaders = await getAuthHeader();
    const path = withReleaseFlags("/single-documents/download-zip", flags);
    const response = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        cache: "no-store",
        headers: {
            "Content-Type": "application/json",
            ...authHeaders,
            ...releaseHeaders(flags),
        },
        body: JSON.stringify({ document_ids: documentIds }),
    });
    if (!response.ok) {
        throw await toApiError(response, path);
    }
    return response.blob();
}

export async function downloadDocumentsZip(
    documentIds: string[],
): Promise<Blob> {
    return confirmOutboundRelease((flags) =>
        requestDocumentsZip(documentIds, flags),
    );
}

function filenameFromContentDisposition(header: string | null): string | null {
    if (!header) return null;
    const star = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (star?.[1]) {
        try {
            return decodeURIComponent(star[1]);
        } catch {
            return star[1];
        }
    }
    const plain = header.match(/filename="([^"]+)"/i);
    return plain?.[1] ?? null;
}

async function requestGatedDocument(
    documentId: string,
    versionId: string | null | undefined,
    flags: OutboundReleaseFlags,
): Promise<{ blob: Blob; filename: string }> {
    const authHeaders = await getAuthHeader();
    const params = new URLSearchParams();
    if (versionId) params.set("version_id", versionId);
    if (flags.confirmTrackedChanges) params.set("confirm_tracked_changes", "1");
    if (flags.allowOpenComments) params.set("allow_open_comments", "1");
    const qs = params.toString();
    const path = `/single-documents/${documentId}/export${qs ? `?${qs}` : ""}`;
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        headers: { ...authHeaders, ...releaseHeaders(flags) },
    });
    if (!response.ok) throw await toApiError(response, path);
    return {
        blob: await response.blob(),
        filename:
            filenameFromContentDisposition(
                response.headers.get("content-disposition"),
            ) ?? "document",
    };
}

/** Stream a document through the export gate (scrub, then fail closed). */
export async function downloadGatedDocument(
    documentId: string,
    versionId?: string | null,
): Promise<{ blob: Blob; filename: string }> {
    return confirmOutboundRelease((flags) =>
        requestGatedDocument(documentId, versionId, flags),
    );
}

export async function fetchDocxBytes(
    documentId: string,
    versionId?: string | null,
    options?: Partial<OutboundReleaseFlags>,
): Promise<ArrayBuffer> {
    const flags: OutboundReleaseFlags = {
        confirmTrackedChanges: !!options?.confirmTrackedChanges,
        allowOpenComments: !!options?.allowOpenComments,
    };
    const authHeaders = await getAuthHeader();
    const params = new URLSearchParams();
    if (versionId) params.set("version_id", versionId);
    if (flags.confirmTrackedChanges) params.set("confirm_tracked_changes", "1");
    if (flags.allowOpenComments) params.set("allow_open_comments", "1");
    const qs = params.toString();
    const path = `/single-documents/${documentId}/docx${qs ? `?${qs}` : ""}`;
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        headers: {
            ...authHeaders,
            ...releaseHeaders(flags),
        },
    });
    if (!response.ok) throw await toApiError(response, path);
    return response.arrayBuffer();
}

/** `/docx` download used by the document panel. Confirms each release. */
export async function downloadDocxDocument(
    documentId: string,
    filename: string,
    versionId?: string | null,
): Promise<{ blob: Blob; filename: string }> {
    const buffer = await confirmOutboundRelease((flags) =>
        fetchDocxBytes(documentId, versionId, flags),
    );
    return {
        blob: new Blob([buffer], {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
        filename,
    };
}

export function saveBlobDownload(blob: Blob, filename: string) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(href);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
    project_id?: string;
}): Promise<{ id: string }> {
    return apiRequest<{ id: string }>("/chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });
}

export async function listChats(options?: { limit?: number }): Promise<Chat[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return apiRequest<Chat[]>(`/chat${query ? `?${query}` : ""}`);
}

export async function listProjectChats(projectId: string): Promise<Chat[]> {
    return apiRequest<Chat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<ChatDetailOut> {
    const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
    const messages: Message[] = raw.messages.map((m) => {
        if (m.role === "user") {
            return {
                role: "user",
                content: typeof m.content === "string" ? m.content : "",
                files: m.files ?? undefined,
                workflow: m.workflow ?? undefined,
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        return {
            role: "assistant",
            content:
                events
                    ?.filter((e) => e.type === "content")
                    .map((e) => (e as { type: "content"; text: string }).text)
                    .join("") ?? "",
            annotations: m.annotations ?? undefined,
            events,
        };
    });
    return { chat: raw.chat, messages };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function deleteChat(chatId: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

export async function generateChatTitle(
    chatId: string,
    message: string,
): Promise<{ title: string }> {
    return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
    });
}

export type CaseLawOpinion = {
    opinionId: number | null;
    apiUrl?: string | null;
    type: string | null;
    author: string | null;
    url: string | null;
    text?: string | null;
    html?: string | null;
};

export async function getCourtlistenerOpinions(
    clusterId: number,
): Promise<CaseLawOpinion[]> {
    const result = await apiRequest<{ opinions: CaseLawOpinion[] }>(
        "/case-law/case-opinions",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                clusterId,
            }),
        },
    );
    return result.opinions;
}

export async function streamChat(payload: {
    messages: {
        role: string;
        content: string;
        files?: { filename: string; document_id?: string }[];
        workflow?: { id: string; title: string };
    }[];
    chat_id?: string;
    project_id?: string;
    model?: string;
    signal?: AbortSignal;
}): Promise<Response> {
    const { signal, ...body } = payload;
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...authHeaders,
        },
        body: JSON.stringify(body),
        signal,
    });
}

type StreamChatMessage = {
    role: string;
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
};

export async function streamProjectChat(payload: {
    projectId: string;
    messages: StreamChatMessage[];
    chat_id?: string;
    model?: string;
    displayed_doc?: { filename: string; document_id: string };
    attached_documents?: { filename: string; document_id: string }[];
    signal?: AbortSignal;
}): Promise<Response> {
    const { projectId, signal, ...body } = payload;
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/projects/${projectId}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...authHeaders,
        },
        body: JSON.stringify(body),
        signal,
    });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
    projectId?: string,
): Promise<TabularReview[]> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return apiRequest<TabularReview[]>(`/tabular-review${qs}`);
}

export async function createTabularReview(payload: {
    title?: string;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
    project_id?: string;
}): Promise<TabularReview> {
    return apiRequest<TabularReview>("/tabular-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReview(
    reviewId: string,
): Promise<TabularReviewDetailOut> {
    return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
    reviewId: string,
    payload: {
        title?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        document_ids?: string[];
        project_id?: string | null;
        shared_with?: string[];
    },
): Promise<TabularReview> {
    return apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReviewPeople(
    reviewId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function generateTabularColumnPrompt(
    title: string,
    options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
    return apiRequest<{
        prompt: string;
        source: "preset" | "llm" | "fallback";
    }>("/tabular-review/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title,
            format: options?.format,
            documentName: options?.documentName,
            tags: options?.tags,
        }),
    });
}

export async function uploadReviewDocument(
    reviewId: string,
    file: File,
    options?: {
        projectId?: string;
        documentIds?: string[];
        columnsConfig?: { index: number; name: string; prompt: string }[];
    },
): Promise<Document> {
    const uploaded = options?.projectId
        ? await uploadProjectDocument(options.projectId, file)
        : await uploadStandaloneDocument(file);

    await updateTabularReview(reviewId, {
        columns_config: options?.columnsConfig,
        document_ids: [...(options?.documentIds ?? []), uploaded.id],
    });

    return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
    reviewId: string,
): Promise<Response> {
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
        method: "POST",
        headers: { ...authHeaders },
    });
}

export async function streamTabularChat(
    reviewId: string,
    messages: { role: string; content: string }[],
    chat_id?: string | null,
    signal?: AbortSignal,
    context?: { reviewTitle?: string | null; projectName?: string | null },
): Promise<Response> {
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/tabular-review/${reviewId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
            messages,
            chat_id: chat_id ?? undefined,
            review_title: context?.reviewTitle ?? undefined,
            project_name: context?.projectName ?? undefined,
        }),
        signal: signal ?? undefined,
    });
}

export interface TRCitationAnnotation {
    type: "tabular_citation";
    ref: number;
    col_index: number;
    row_index: number;
    col_name: string;
    doc_name: string;
    quote: string;
}

interface RawTRMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    annotations?: TRCitationAnnotation[] | null;
    created_at: string;
}

export interface TRDisplayMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
}

export interface TRChat {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
    return raw.map((m) => {
        if (m.role === "user") {
            return {
                role: "user" as const,
                content: typeof m.content === "string" ? m.content : "",
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        const content =
            events
                ?.filter((e) => e.type === "content")
                .map((e) => (e as { type: "content"; text: string }).text)
                .join("") ?? "";
        return {
            role: "assistant" as const,
            content,
            events,
            annotations: m.annotations ?? undefined,
        };
    });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
    return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
    reviewId: string,
    chatId: string,
): Promise<RawTRMessage[]> {
    return apiRequest<RawTRMessage[]>(
        `/tabular-review/${reviewId}/chats/${chatId}/messages`,
    );
}

export async function deleteTabularChat(
    reviewId: string,
    chatId: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "DELETE",
    });
}

export async function regenerateTabularCell(
    reviewId: string,
    documentId: string,
    columnIndex: number,
): Promise<{
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
}> {
    return apiRequest(`/tabular-review/${reviewId}/regenerate-cell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            document_id: documentId,
            column_index: columnIndex,
        }),
    });
}

export async function clearTabularCells(
    reviewId: string,
    documentIds: string[],
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: documentIds }),
    });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = Workflow["type"];

export async function listWorkflows(
    type: WorkflowType,
): Promise<Workflow[]> {
    return apiRequest<Workflow[]>(`/workflows?type=${type}`);
}

export async function getWorkflow(workflowId: string): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
    title: string;
    type: "assistant" | "tabular";
    prompt_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    practice?: string | null;
}): Promise<Workflow> {
    return apiRequest<Workflow>("/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateWorkflow(
    workflowId: string,
    payload: {
        title?: string;
        prompt_md?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        practice?: string | null;
    },
): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function listHiddenWorkflows(): Promise<string[]> {
    return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
    await apiRequest("/workflows/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId }),
    });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
    workflowId: string,
    payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
    await apiRequest<void>(`/workflows/${workflowId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listWorkflowShares(workflowId: string): Promise<
    {
        id: string;
        shared_with_email: string;
        allow_edit: boolean;
        created_at: string;
    }[]
> {
    return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
    workflowId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
        method: "DELETE",
    });
}
