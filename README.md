# Tyk gRPC Plugin - Node.js

A simple gRPC plugin for Tyk Gateway written in Node.js.

## Features

- **Pre-request middleware**: Adds custom headers and logs requests
- **Custom authentication**: Simple token validation example
- **Event handling**: Handles auth failure events

## Setup

### 1. Install Dependencies

```bash
cd grpc-plugin-node
npm install
```

### 2. Start the gRPC Plugin Server

```bash
# Or directly:
npm run dev
```

The server will start on port 5555 by default.

### 3. Configure Tyk Gateway

Update your Tyk configuration (`tyk.conf`) to enable gRPC coprocess:

```json
"coprocess_options": {
  "enable_coprocess": true,
  "coprocess_grpc_server": "tcp://localhost:5555"
}
```

### 4. Load the API Definition

Import the api definition into your Tyk Install:

```bash
api-definition.json
```

### 5. Restart Tyk Gateway

## Testing

### Test the pre-middleware (adds custom header):
```bash
curl -i http://localhost:8080/grpc-test/get
```

Look for the `X-Custom-Header: Processed-By-gRPC-Plugin` in the response.

### Test with a special token:
```bash
curl -i http://localhost:8080/grpc-test/headers \
  -H "Authorization: Bearer special-token"
```

This will add an additional `X-Special-User: true` header.

## How It Works

1. **server.js**: The main gRPC server that implements the Tyk Dispatcher service
2. **proto/**: Contains Tyk's protocol buffer definitions
3. **api-definition.json**: API definition containing the pre-defined plugin

The plugin intercepts requests at various stages:
- **Pre-middleware**: Runs before the request is proxied
- **Auth middleware**: Can validate tokens and create sessions
- **Event handlers**: React to events like authentication failures

## Customization

Modify `server.js` to add your own logic:

- `MyPreMiddleware()`: Add request preprocessing

## Environment Variables

- `GRPC_PORT`: Change the gRPC server port (default: 5555)