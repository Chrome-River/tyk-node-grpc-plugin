const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const https = require('https');
const dotenv = require('dotenv').config();
const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { fromContainerMetadata } = require("@aws-sdk/credential-providers");

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

// Map of cluster string to region URL
const clusterRegionMap = {
  'c1': 'api-poc.uat.us.chromeriver.com',
  'c3': 'api-poc.uat.eu1.chromeriver.com',
  'c4': 'api-poc.uat.us2.chromeriver.com',
  'c5': 'api-poc.uat.ca1.chromeriver.com',
  'c7': 'api-poc.uat.us2.chromeriver.com',
};

async function makeUpstreamCall(targetHost, object) {
  return new Promise((resolve, reject) => {

    // Build the target URL with the new host but same path and query
    const targetUrl = `https://${targetHost}${object.request.url}`;
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
  const customerCode = getCustomerCodeFromHeaders(object);
  const customerId = getCustomerIdFromHeaders(object);

  // Throw error if neither customerCode nor customerId is defined
  if (!customerCode && !customerId) {
    object.request.return_overrides = {
      response_code: 400,
      response_body: 'Bad Request: Neither customerCode nor customerId is defined in request headers.',
      headers: { 'Content-Type': 'text/plain' }
    };
    return object;
  }

  console.log('Customer code or ID header detected!');
  const cluster = await getClusterForCustomer(customerCode, customerId);

  if (!cluster) {
    object.request.return_overrides = {
      response_code: 400,
      response_body: 'Bad Request: Could not find cluster information for ' + (customerCode || customerId) + '.',
      headers: { 'Content-Type': 'text/plain' }
    };
    return object;
  }

  console.log('Found cluster for customer code:', cluster);
  // object.request.set_headers['X-Cluster'] = clusterRegionMap[cluster] || 'unknown';
  // return object;

  try {
    const response = await makeUpstreamCall(clusterRegionMap[cluster], object);
    console.log('Response:', response);

    // Use return_overrides to send response directly
    object.request.return_overrides = {
      response_code: response.status,
      response_body: response.body,
      headers: response.headers,
    };
  } catch (error) {
    console.log('Error calling upstream:', error);

    object.request.return_overrides = {
      response_code: 500,
      response_body: 'Middleware Error: Error calling upstream for customer ' + (customerCode || customerId) + '.',
      headers: { 'Content-Type': 'text/plain' }
    };
  }

  return object;
}

function getCustomerCodeFromHeaders(object) {
  const headers = object.request.headers || {};
  const customerCode = Object.keys(headers).reduce((acc, key) => {
    if (key.toLowerCase() === 'customercode' || key.toLowerCase() === 'customer-code') {
      return headers[key];
    }
    return acc;
  }, undefined);
  return customerCode;
}

function getCustomerIdFromHeaders(object) {
  const headers = object.request.headers || {};
  const customerId = Object.keys(headers).reduce((acc, key) => {
    if (key.toLowerCase() === 'customerid' || key.toLowerCase() === 'customer-id') {
      return headers[key];
    }
    return acc;
  }, undefined);
  return customerId;
}

// Simple in-memory cache
const clusterCache = {};

/**
 * Returns the cluster for a given customerCode or customerId.
 * Checks cache first; if not found, queries DynamoDB and caches the result.
 * Returns null if neither is provided or cluster is not found
 */
async function getClusterForCustomer(customerCode, customerId) {
  // Use customerCode as cache key if present, otherwise customerId
  const cacheKey = customerCode ? `customerCode:${customerCode}` : customerId ? `customerId:${customerId}` : null;

  if (!cacheKey) return null;

  if (!clusterCache[cacheKey]) {
    // Not in cache, query DynamoDB
    let cluster = null;
    if (customerCode) {
      cluster = await queryClusterByIndex('customerCode-index', 'customerCode', customerCode);
    } else if (customerId) {
      cluster = await queryClusterByIndex('customerId-index', 'customerId', customerId);
    }

    // Cache the result if found
    if (cluster) clusterCache[cacheKey] = cluster;
  }

  return clusterCache[cacheKey];
}

async function queryClusterByIndex(indexName, keyName, keyValue) {
  console.log(`Querying DynamoDB for ${keyName}=${keyValue} using index ${indexName}`);

  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: fromContainerMetadata(),
  });

  const params = {
    TableName: process.env.AWS_DYNAMODB_TABLE || 'tbl_dispatcher_customer-routing-cX-dev',
    IndexName: indexName,
    KeyConditionExpression: `${keyName} = :value`,
    ExpressionAttributeValues: {
      ':value': { S: keyValue }
    },
    ProjectionExpression: '#cluster',
    ExpressionAttributeNames: {
      '#cluster': 'cluster'
    },
    Limit: 1
  };

  try {
    const data = await client.send(new QueryCommand(params));
    if (data.Items && data.Items.length > 0 && data.Items[0].cluster && data.Items[0].cluster.S) {
      return data.Items[0].cluster.S;
    }
    return null;
  } catch (error) {
    console.error('Error querying DynamoDB:', error);
    return null;
  }
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