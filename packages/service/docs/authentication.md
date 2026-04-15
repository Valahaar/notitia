# GCP Scheduling Authentication

## Overview

The GCP scheduling endpoints require authentication using a simple token-based mechanism to ensure only authorized services can access these internal endpoints.

## Configuration

Set the following environment variable:

```bash
AUTH_TOKEN=your-secure-token-here
```

## Usage

All requests to the publicly-available endpoints must include the Authorization header:

```
Authorization: Bearer your-secure-token-here
```

## Protected Endpoints

The following endpoints now require authentication:

- `POST /meta/:id` - Meta job processing endpoint
- `POST /relay` - GCP task relay endpoint

## Example

```bash
curl -X POST http://your-service/meta/123 \
  -H "Authorization: Bearer your-secure-token-here" \
  -H "Content-Type: application/json" \
  -d '{"target": "https://example.com", "method": "POST", "payload": {}}'
```

## Security Notes

- Use a strong, randomly generated token
- Keep the token secure and don't commit it to version control
- Rotate the token periodically
- The token should be shared only with authorized GCP services

## Error Responses

- `401 Unauthorized` - Missing or invalid Authorization header
- `401 Unauthorized` - Invalid token
- `500 Internal Server Error` - Authentication not properly configured (missing environment variable)
