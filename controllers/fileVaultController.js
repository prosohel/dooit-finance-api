/**
 * FileVault Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Proxies file operations to the external FileVault API via fileVaultService.
 *
 * Routes:
 *   POST   /api/v1/file-vault/upload          – upload a single file
 *   POST   /api/v1/file-vault/chunk           – upload a file chunk
 *   GET    /api/v1/file-vault                 – list files
 *   GET    /api/v1/file-vault/:id             – stream / download a file
 *   GET    /api/v1/file-vault/:id/url         – get direct URL for a file
 *   DELETE /api/v1/file-vault/:id             – soft-delete a file
 *   DELETE /api/v1/file-vault/bulk/delete     – bulk delete files
 *   POST   /api/v1/file-vault/restore         – restore soft-deleted files
 */

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const fileVaultService = require("../utils/fileVaultService");
const { logEvent } = require("../utils/audit");

// ── Upload ────────────────────────────────────────────────────────────────────

// @desc    Upload a single file to FileVault
// @route   POST /api/v1/file-vault/upload
// @access  Private
exports.uploadFile = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['FileVault']
    #swagger.summary = 'Upload a single file to FileVault'
    #swagger.consumes = ['multipart/form-data']
    #swagger.parameters['file'] = { in: 'formData', type: 'file', required: true }
    #swagger.responses[200] = { description: 'File uploaded successfully' }
    #swagger.responses[400] = { description: 'No file provided' }
    #swagger.responses[401] = { description: 'Unauthorized' }
  */

  if (!req.file) {
    return next(new ErrorResponse("Please upload a file", 400));
  }

  const { buffer, originalname, mimetype } = req.file;

  let result;
  try {
    result = await fileVaultService.uploadFile(buffer, originalname, mimetype);
  } catch (err) {
    // The vault is an external service: report its answer, never the raw axios error (which is circular and crashed res.json).
    const status = err.response?.status ?? 502;
    const detail = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
    logEvent({ req, service: "file", action: "file_upload_failed", status: "failure", target: originalname, details: String(detail) });
    return next(new ErrorResponse(`File vault upload failed: ${detail}`, status >= 500 ? 502 : status));
  }

  logEvent({ req, service: "file", action: "file_uploaded", target: originalname });

  res.status(200).json(
    result
  );
});

// @desc    Upload a file chunk (for large files > 5 MB)
// @route   POST /api/v1/file-vault/chunk
// @access  Private
exports.uploadChunk = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['FileVault']
    #swagger.summary = 'Upload a file chunk for large files'
    #swagger.consumes = ['multipart/form-data']
    #swagger.responses[200] = { description: 'Chunk uploaded' }
    #swagger.responses[400] = { description: 'Bad request' }
    #swagger.responses[401] = { description: 'Unauthorized' }
  */
  if (!req.file) {
    return next(new ErrorResponse("Please provide a chunk", 400));
  }

  const { fileId, chunkIndex, totalChunks } = req.body;

  if (!fileId || chunkIndex === undefined || !totalChunks) {
    return next(
      new ErrorResponse("fileId, chunkIndex and totalChunks are required", 400)
    );
  }

  const result = await fileVaultService.uploadChunk(
    req.file.buffer,
    fileId,
    Number(chunkIndex),
    Number(totalChunks)
  );

  res.status(200).json({
    success: true,
    message: result.message || "Chunk uploaded successfully",
  });
});

// ── Listing ───────────────────────────────────────────────────────────────────

// @desc    List files from FileVault with pagination and filters
// @route   GET /api/v1/file-vault
// @access  Private
exports.listFiles = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['FileVault']
    #swagger.summary = 'List files from FileVault'
    #swagger.parameters['page']     = { in: 'query', type: 'integer', default: 1 }
    #swagger.parameters['limit']    = { in: 'query', type: 'integer', default: 20 }
    #swagger.parameters['q']        = { in: 'query', type: 'string', description: 'Search term' }
    #swagger.parameters['folder']   = { in: 'query', type: 'string' }
    #swagger.parameters['mimetype'] = { in: 'query', type: 'string' }
    #swagger.responses[200] = { description: 'Success' }
    #swagger.responses[401] = { description: 'Unauthorized' }
  */
  const { page, limit, q, folder, mimetype } = req.query;

  const result = await fileVaultService.listFiles({ page, limit, q, folder, mimetype });

  res.status(200).json({
    success: true,
    meta: result.meta,
    data: result.data,
  });
});

// ── Download / Stream ─────────────────────────────────────────────────────────

// @desc    Stream/download a file by ID
// @route   GET /api/v1/file-vault/:id
// @access  Private
exports.getFile = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['FileVault']
    #swagger.summary = 'Download a file by ID'
    #swagger.parameters['id'] = { in: 'path', required: true, type: 'string' }
    #swagger.responses[200] = { description: 'Binary file data' }
    #swagger.responses[404] = { description: 'File not found' }
    #swagger.responses[401] = { description: 'Unauthorized' }
  */
  try {
    const response = await fileVaultService.getFileStream(req.params.id);

    // Forward the content headers from FileVault
    const contentType = response.headers["content-type"];
    const contentDisposition = response.headers["content-disposition"];
    const contentLength = response.headers["content-length"];

    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentDisposition) res.setHeader("Content-Disposition", contentDisposition);
    if (contentLength) res.setHeader("Content-Length", contentLength);

    // Evidence / ID-document access — the download itself is the audit target
    logEvent({ req, service: "file", action: "file_downloaded", target: req.params.id });

    // Pipe the FileVault stream directly to the client
    response.data.pipe(res);

    // Handle upstream errors mid-stream
    response.data.on("error", (err) => {
      console.error("[FileVault] Stream error:", err.message);
      if (!res.headersSent) {
        next(new ErrorResponse("Error streaming file", 500));
      }
    });
  } catch (error) {
    const status = error.response?.status;
    if (status === 404) {
      return next(new ErrorResponse("File not found in FileVault", 404));
    }
    return next(
      new ErrorResponse(
        error.response?.data?.message || "Failed to retrieve file",
        status || 500
      )
    );
  }
});

// @desc    Get the direct FileVault URL for a file
// @route   GET /api/v1/file-vault/:id/url
// @access  Private
exports.getFileUrl = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['FileVault']
    #swagger.summary = 'Get direct FileVault URL for a file'
    #swagger.parameters['id'] = { in: 'path', required: true, type: 'string' }
    #swagger.responses[200] = { description: 'Success' }
    #swagger.responses[401] = { description: 'Unauthorized' }
  */
  const url = fileVaultService.getFileUrl(req.params.id);

  res.status(200).json({
    success: true,
    data: { url },
  });
});

// ── Deletion ──────────────────────────────────────────────────────────────────

// @desc    Soft-delete a single file
// @route   DELETE /api/v1/file-vault/:id
// @access  Private
exports.deleteFile = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['FileVault']
    #swagger.summary = 'Soft-delete a file by ID'
    #swagger.parameters['id'] = { in: 'path', required: true, type: 'string' }
    #swagger.responses[200] = { description: 'File deleted' }
    #swagger.responses[404] = { description: 'File not found' }
    #swagger.responses[401] = { description: 'Unauthorized' }
  */
  try {
    const result = await fileVaultService.deleteFile(req.params.id);

    logEvent({ req, service: "file", action: "file_deleted", target: req.params.id });

    res.status(200).json({
      success: true,
      message: result.message || "File deleted successfully",
    });
  } catch (error) {
    const status = error.response?.status;
    if (status === 404) {
      return next(new ErrorResponse("File not found in FileVault", 404));
    }
    return next(
      new ErrorResponse(
        error.response?.data?.message || "Failed to delete file",
        status || 500
      )
    );
  }
});

// @desc    Bulk soft-delete multiple files
// @route   DELETE /api/v1/file-vault/bulk/delete
// @access  Private
exports.bulkDeleteFiles = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['FileVault']
    #swagger.summary = 'Bulk delete multiple files'
    #swagger.parameters['body'] = {
      in: 'body', required: true,
      schema: { fileIds: ['64f1a2b3c4d5e6f7g8h9i0j1'] }
    }
    #swagger.responses[200] = { description: 'Files deleted' }
    #swagger.responses[400] = { description: 'Bad request' }
    #swagger.responses[401] = { description: 'Unauthorized' }
  */
  const { fileIds } = req.body;

  if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
    return next(new ErrorResponse("Please provide a non-empty array of fileIds", 400));
  }

  const result = await fileVaultService.bulkDeleteFiles(fileIds);

  logEvent({ req, service: "file", action: "file_bulk_deleted", afterValue: { fileIds } });

  res.status(200).json({
    success: true,
    message: result.message || `${fileIds.length} file(s) deleted successfully`,
  });
});

// ── Restore ───────────────────────────────────────────────────────────────────

// @desc    Restore soft-deleted files
// @route   POST /api/v1/file-vault/restore
// @access  Private
exports.restoreFiles = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['FileVault']
    #swagger.summary = 'Restore soft-deleted files'
    #swagger.parameters['body'] = {
      in: 'body', required: true,
      schema: { fileIds: ['64f1a2b3c4d5e6f7g8h9i0j1'] }
    }
    #swagger.responses[200] = { description: 'Files restored' }
    #swagger.responses[400] = { description: 'Bad request' }
    #swagger.responses[401] = { description: 'Unauthorized' }
  */
  const { fileIds } = req.body;

  if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
    return next(new ErrorResponse("Please provide a non-empty array of fileIds", 400));
  }

  const result = await fileVaultService.restoreFiles(fileIds);

  logEvent({ req, service: "file", action: "file_restored", afterValue: { fileIds } });

  res.status(200).json({
    success: true,
    data: result,
    message: `${result.restored ?? fileIds.length} file(s) restored successfully`,
  });
});
