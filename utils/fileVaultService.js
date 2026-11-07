/**
 * FileVault Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin axios wrapper around the FileVault API.
 *
 * Env vars required:
 *   NEXT_PUBLIC_IMAGE_SERVER_URL  – base URL, e.g. https://files.strikeo.com/api/v1
 *   IMAGE_API_KEY                 – API key sent as  x-api-key  header
 */

const axios = require("axios");
const FormData = require("form-data");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns { baseURL, apiKey } or throws if env vars are missing.
 */
const getConfig = () => {
  const baseURL = (process.env.NEXT_PUBLIC_IMAGE_SERVER_URL || "").replace(
    /\/+$/,
    ""
  );
  const apiKey = process.env.IMAGE_API_KEY;

  if (!baseURL || !apiKey) {
    throw new Error(
      "FileVault config missing. Set NEXT_PUBLIC_IMAGE_SERVER_URL and IMAGE_API_KEY."
    );
  }

  return { baseURL, apiKey };
};

/**
 * Creates a pre-configured axios instance for the FileVault API.
 */
const createClient = (extraHeaders = {}) => {
  const { baseURL, apiKey } = getConfig();
  return axios.create({
    baseURL,
    headers: { "x-api-key": apiKey, ...extraHeaders },
    timeout: 60_000,
  });
};

// ── File Upload ───────────────────────────────────────────────────────────────

/**
 * Upload a single file buffer to FileVault.
 *
 * @param {Buffer}  buffer       – file contents from multer memoryStorage
 * @param {string}  originalName – original filename (e.g. "invoice.pdf")
 * @param {string}  mimetype     – MIME type  (e.g. "application/pdf")
 * @returns {Promise<{ success, data }>}
 */
/**
 * The vault refuses `text/*` uploads (500) but takes Office types. Customer data
 * dumps arrive as CSV from browsers (`text/csv`), so they are stored under the
 * Excel media type Windows itself registers for .csv; the caller keeps the
 * original type on its own record.
 */
const VAULT_MIME = { "text/csv": "application/vnd.ms-excel", "application/csv": "application/vnd.ms-excel", "text/comma-separated-values": "application/vnd.ms-excel" };
const vaultMimeOf = (mimetype) => VAULT_MIME[String(mimetype ?? "").toLowerCase()] ?? mimetype;

exports.uploadFile = async (buffer, originalName, mimetype) => {
  const { baseURL, apiKey } = getConfig();

  const form = new FormData();
  form.append("file", buffer, { filename: originalName, contentType: vaultMimeOf(mimetype) });

  const response = await axios.post(`${baseURL}/files/upload-api`, form, {
    headers: {
      ...form.getHeaders(),
      "x-api-key": apiKey,
    },
    maxBodyLength: Infinity,
    timeout: 120_000,
  });

  return response.data;
};

/**
 * Upload a chunk for large-file uploads.
 *
 * @param {Buffer}  chunkBuffer  – chunk buffer
 * @param {string}  fileId       – unique file identifier (client-generated)
 * @param {number}  chunkIndex   – 0-based chunk index
 * @param {number}  totalChunks  – total number of chunks
 * @returns {Promise<{ success, message }>}
 */
exports.uploadChunk = async (chunkBuffer, fileId, chunkIndex, totalChunks) => {
  const { baseURL, apiKey } = getConfig();

  const form = new FormData();
  form.append("chunk", chunkBuffer, { filename: `chunk_${chunkIndex}` });
  form.append("fileId", fileId);
  form.append("chunkIndex", String(chunkIndex));
  form.append("totalChunks", String(totalChunks));

  const response = await axios.post(`${baseURL}/files/chunk`, form, {
    headers: {
      ...form.getHeaders(),
      "x-api-key": apiKey,
    },
    maxBodyLength: Infinity,
    timeout: 120_000,
  });

  return response.data;
};

// ── File Listing ──────────────────────────────────────────────────────────────

/**
 * List files with optional pagination/filter query params.
 *
 * @param {object} query  – { page, limit, q, folder, mimetype }
 * @returns {Promise<{ success, meta, data }>}
 */
exports.listFiles = async (query = {}) => {
  const client = createClient();
  // Strip undefined values so axios doesn't send empty params
  const params = Object.fromEntries(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== "")
  );
  const response = await client.get("/files", { params });
  return response.data;
};

// ── File Download / Stream ────────────────────────────────────────────────────

/**
 * Fetch a file as a readable stream (pipe directly to Express res).
 *
 * @param {string} fileId
 * @returns {Promise<AxiosResponse>}  – response.data is a Readable stream
 */
exports.getFileStream = async (fileId) => {
  const client = createClient();
  const response = await client.get(`/files/${fileId}`, {
    responseType: "stream",
  });
  return response;
};

/**
 * Fetch a file as a Buffer (for small files / in-memory use).
 *
 * @param {string} fileId
 * @returns {Promise<Buffer>}
 */
exports.getFileBuffer = async (fileId) => {
  const client = createClient();
  const response = await client.get(`/files/${fileId}`, {
    responseType: "arraybuffer",
  });
  return Buffer.from(response.data);
};

// ── File Deletion / Restore ───────────────────────────────────────────────────

/**
 * Soft-delete a single file.
 *
 * @param {string} fileId
 * @returns {Promise<{ success, message }>}
 */
exports.deleteFile = async (fileId) => {
  const client = createClient();
  const response = await client.delete(`/files/${fileId}`);
  return response.data;
};

/**
 * Bulk soft-delete multiple files.
 *
 * @param {string[]} fileIds
 * @returns {Promise<{ success, message }>}
 */
exports.bulkDeleteFiles = async (fileIds) => {
  const client = createClient();
  const response = await client.delete("/files/bulk/delete", {
    data: { fileIds },
  });
  return response.data;
};

/**
 * Restore soft-deleted files.
 *
 * @param {string[]} fileIds
 * @returns {Promise<{ success, restored }>}
 */
exports.restoreFiles = async (fileIds) => {
  const client = createClient();
  const response = await client.post("/files/restore", { fileIds });
  return response.data;
};

// ── URL Helper ────────────────────────────────────────────────────────────────

/**
 * Build the public URL for a file (useful for embedding in responses).
 *
 * @param {string} fileId
 * @returns {string}
 */
exports.getFileUrl = (fileId) => {
  const { baseURL } = getConfig();
  return `${baseURL}/files/${fileId}`;
};
