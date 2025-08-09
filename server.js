const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const https = require('https');

// Load proto files
const PROTO_PATH = path.join(__dirname, 'proto', 'coprocess_object.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.join(__dirname, 'proto')]
});

const coprocessProto = grpc.loadPackageDefinition(packageDefinition).coprocess;

async function makeUpstreamCall(object) {
  return new Promise((resolve, reject) => {
    // Hardcoded host
    const targetHost = 'httpbingo.org'; 
    
    // Build the target URL with the new host but same path and query
    // const targetUrl = `https://${targetHost}${object.request.url}`;
    const targetUrl = `https://${targetHost}/get`;
    console.log('targetUrl', targetUrl);
    
    // Prepare headers - exclude host header and add original headers
    const headers = { ...object.request.headers };
    delete headers['Host']; // Remove original host header
    headers['Host'] = targetHost; // Set new host
    
    // Parse the URL for the request
    const parsedUrl = new URL(targetUrl);
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: object.request.method || 'GET',
      headers: headers
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ 
        status: res.statusCode, 
        headers: res.headers, 
        body: data 
      }));
    });
    
    req.on('error', reject);
    
    // Forward the request body if it exists
    if (object.request.body && object.request.method !== 'GET' && object.request.method !== 'HEAD') {
      req.write(object.request.body);
    }
    
    req.end();
  });
}

// Simple middleware that logs requests and adds a custom header
async function MyPreMiddleware(object) {
  // Add a custom header to the request
  if (!object.request.set_headers) {
    object.request.set_headers = {};
  }
  object.request.set_headers['X-Custom-Header'] = 'Processed-By-gRPC-Plugin';

  // Example: Custom Logic Here...
  const regionHeader = object.request.headers['X-Customer-Id'];
  if (regionHeader) {
    console.log('Region header detected! Skipping reverse proxy.');
    return object;
  }

  try {
    console.log('Making upstream call');
    const response = await makeUpstreamCall(object);
    console.log('Response:', response);
      
      // Use return_overrides to send response directly
      object.request.return_overrides = {
        response_code: response.status,
        response_body: response.body,
        headers: response.headers,
      };
      
      console.log('Returning override response');
    } catch (error) {
      console.error('Error making upstream call:', error);
    }

  return object;
}

// Main dispatcher function that routes to appropriate middleware
async function dispatch(call, callback) {
  const object = call.request;
  
  console.log('Dispatching hook:', object.hook_name);
  
  let result = object;
  
  switch (object.hook_name) {
    case 'MyPreMiddleware':
      result = await MyPreMiddleware(object);
      break;
        
    default:
      console.log('Unknown hook:', object.hook_name);
  }
  
  callback(null, result);
}

// Start the gRPC server
function main() {
  const server = new grpc.Server();
  
  server.addService(coprocessProto.Dispatcher.service, {
    Dispatch: dispatch,
    DispatchEvent: dispatch // Events use the same handler
  });
  
  const port = process.env.GRPC_PORT || '5555';
  const address = `0.0.0.0:${port}`;
  
  server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      console.error('Failed to bind server:', err);
      process.exit(1);
    }
    
    console.log(`gRPC plugin server started on port ${port}`);
    console.log('Waiting for Tyk Gateway connections...');
    server.start();
  });
}

main();