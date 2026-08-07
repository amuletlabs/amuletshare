# Share API behavior

This service clones the file-sharing API behavior of Tokiwa Space. URL shortening and `/api/links` are out of scope.

Production base URL: <https://share.amulet.so>

## Limits and retention

Limits are evaluated using the stored file's exact byte size.

| Size | Upload mode | Retention |
| --- | --- | --- |
| `< 50,000,000` bytes | Direct | Forever |
| `50,000,000–99,999,999` bytes | Direct | 7 days |
| `100,000,000–1,000,000,000` bytes | Multipart | 7 days |
| `> 1,000,000,000` bytes | Rejected | Not stored |

Clients cannot override retention. `expires_at` is `null` for permanent files and an ISO 8601 timestamp for files retained for seven days.

## Password behavior

There are two independent passwords:

- `password` is an optional view password. If omitted, anyone with the file URL can download the file and read its metadata.
- `edit_password` is an optional management password. It authorizes updates and deletion. If omitted during upload, the server generates one and returns it once in the upload response.

The view password can be changed with `PATCH /api/files/:id`. The edit password cannot be changed in the MVP.

Protected downloads and metadata requests pass the view password in the `password` query parameter:

```http
GET /api/files/:id?password=view-secret
GET /api/files/:id/info?password=view-secret
GET /f/:id.ext?password=view-secret
```

Password errors:

- Missing view password: `401 { "error": "Password required" }`
- Incorrect view password: `403 { "error": "Invalid password" }`
- Incorrect edit password: `403 { "error": "Invalid edit password" }`

## Response object

Successful file creation and multipart completion return:

```json
{
  "data": {
    "id": "quiet-river",
    "file_name": "example.txt",
    "mime_type": "text/plain",
    "size_bytes": 1234,
    "expires_at": null,
    "created_at": "2026-08-07T00:00:00.000Z",
    "downloads": 0
  },
  "edit_password": "generated-or-supplied-password",
  "url": "https://share.example.com/f/quiet-river.txt"
}
```

Internal object-storage keys are never returned.

## Direct file upload

Files smaller than 100,000,000 bytes use a single request.

```http
POST /api/files
Content-Type: multipart/form-data
```

| Form field | Required | Behavior |
| --- | --- | --- |
| `file` | Yes | File contents. |
| `filename` | No | Defaults to the uploaded file's name. |
| `mime_type` | No | Defaults to the uploaded type or `application/octet-stream`. |
| `password` | No | View/download password. Omission makes the file public. |
| `edit_password` | No | Management password. The server generates one when omitted. |

Returns `201` with the standard file response.

## Multipart upload

Files from 100,000,000 through 1,000,000,000 bytes use multipart upload.

### 1. Create the upload

```http
POST /api/files/upload-url
Content-Type: application/json
```

| JSON field | Required | Behavior |
| --- | --- | --- |
| `filename` | Yes | Final filename. |
| `size` | Yes | Total file size in bytes. |
| `mime_type` | No | Defaults to `application/octet-stream`. |
| `password` | No | View/download password. |
| `edit_password` | No | Management password. The server generates one when omitted. |

Response:

```json
{
  "file_id": "quiet-river",
  "upload_id": "storage-multipart-upload-id",
  "upload_type": "multipart",
  "edit_password": "generated-or-supplied-password",
  "url": "https://share.example.com/f/quiet-river.zip"
}
```

### 2. Upload each part

```http
POST /api/files/:file_id/upload-part?uploadId=:upload_id&partNumber=:part_number
Content-Type: application/octet-stream

<binary part body>
```

Required inputs:

- `file_id` path parameter
- `uploadId` query parameter
- `partNumber` query parameter, starting at `1`
- Binary request body

Response:

```json
{
  "partNumber": 1,
  "etag": "part-etag"
}
```

### 3. Complete the upload

```http
POST /api/files/:file_id/complete?uploadId=:upload_id
Content-Type: application/json
```

```json
{
  "parts": [
    { "partNumber": 1, "etag": "part-etag" }
  ]
}
```

`parts`, `partNumber`, and `etag` are required. Returns `200` with `data`, `url`, and the completed object `etag`. The edit password is returned only by the create-upload call above, never again.

### Abort an incomplete upload

```http
DELETE /api/files/:file_id/abort?uploadId=:upload_id
```

`file_id` and `uploadId` are required. Abandoned multipart uploads are also removed automatically.

Multipart upload sessions expire after 24 hours. Part numbers must be unique integers from 1 through 10,000. Every non-final part must be the same size and at least 5 MiB. Clients should use consistent 8 MiB parts; only the final part may be smaller.

## Download a file

```http
GET /api/files/:id
GET /f/:id.ext
```

Required input: file ID. `password` is required as a query parameter only when the file is protected. `download=1` is optional and forces an attachment response.

Returns the original file bytes with its stored MIME type and filename. JPEG, PNG, GIF, WebP, and AVIF files open inline by default. HTML, SVG, and every other type remain download-only. All file responses include `X-Content-Type-Options: nosniff`. A successful response increments `downloads`.

## Retrieve metadata

```http
GET /api/files/:id/info
```

Required input: file ID. `password` is required as a query parameter only when the file is protected.

Returns:

```json
{
  "id": "quiet-river",
  "file_name": "example.txt",
  "mime_type": "text/plain",
  "size_bytes": 1234,
  "expires_at": null,
  "created_at": "2026-08-07T00:00:00.000Z",
  "downloads": 0,
  "last_downloaded_at": null
}
```

## Change the view password

```http
PATCH /api/files/:id
Content-Type: application/json
```

```json
{
  "edit_password": "management-secret",
  "password": "new-view-password"
}
```

Both fields are required. A correct edit password replaces the existing view password immediately.

The MVP does not support clearing a view password or changing the edit password. Empty or non-string password values are rejected.

## Delete a file

```http
DELETE /api/files/:id
Content-Type: application/json
```

```json
{
  "edit_password": "management-secret"
}
```

`edit_password` is required. Returns:

```json
{
  "message": "File deleted successfully"
}
```

## Error behavior

All API errors use:

```json
{
  "error": "Human-readable message"
}
```

The `error` value is a short explanation of the specific failure, so clients do not need this document to interpret the response.

| Status | Meaning |
| --- | --- |
| `400` | Invalid request or multipart data. |
| `401` | View password required. |
| `403` | Incorrect view or edit password. |
| `404` | File or upload not found. |
| `410` | File expired. |
| `413` | File too large or direct upload requires multipart. |
| `415` | Unsupported request content type. `POST /api/files` accepts only `multipart/form-data`; URL imports are disabled. |
| `405` | The route exists but does not support the request method. |
| `429` | Rate limit exceeded. |
| `500` | Internal or object-storage failure. |

File-creation requests are limited to 10 per source address per minute and 100 total per Cloudflare location per minute. Multipart part uploads do not consume additional creation tokens.
