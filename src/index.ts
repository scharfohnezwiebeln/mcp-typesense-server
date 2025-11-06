/**
 * Typesense MCP Server
 * A low-level server implementation using Model Context Protocol
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as TypesenseModule from 'typesense';
import express from 'express';
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

interface TypesenseCollection {
  name: string;
  num_documents?: number;
  [key: string]: any;
}

const logger = {
  log: (message: string) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`);
  },
  error: (message: string, error?: any) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error)
  }
};

logger.log(`[INFO] ${new Date().toISOString()} - Starting Typesense MCP Server...`);

type TypesenseConfig = {
  host: string;
  port: number;
  protocol: 'http' | 'https';
  apiKey: string;
};

let typesenseConfig: TypesenseConfig;

let typesenseClient: TypesenseModule.Client;
function initTypesenseClient(config: TypesenseConfig): TypesenseModule.Client {
  return new TypesenseModule.Client({
    nodes: [
      {
        host: config.host,
        port: config.port,
        protocol: config.protocol
      }
    ],
    apiKey: config.apiKey,
    connectionTimeoutSeconds: 5
  });
}

function parseArgs(): TypesenseConfig {
  const args = process.argv.slice(2);
  const config: Partial<TypesenseConfig> = {
    host: 'localhost',
    port: 8108,
    protocol: 'http',
    apiKey: ''
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host' && i + 1 < args.length) {
      config.host = args[++i];
    } else if (arg === '--port' && i + 1 < args.length) {
      config.port = parseInt(args[++i], 10);
    } else if (arg === '--protocol' && i + 1 < args.length) {
      const protocol = args[++i];
      if (protocol === 'http' || protocol === 'https') {
        config.protocol = protocol;
      }
    } else if (arg === '--api-key' && i + 1 < args.length) {
      config.apiKey = args[++i];
    }
  }

  if (!config.apiKey) {
    throw new Error('Typesense API key is required. Use --api-key argument.');
  }

  return config as TypesenseConfig;
}

const server = new Server(
  {
    name: "typesense-mcp-server",
    version: "1.0.0"
  },
  {
    capabilities: {
      resources: {
        read: true,
        list: true,
        templates: true
      },
      tools: {
        list: true,
        call: true
      },
      prompts: {
        list: true,
        get: true
      }
    }
  }
);

async function fetchTypesenseCollections(): Promise<TypesenseCollection[]> {
  try {
    logger.log('Fetching collections from Typesense...');
    const collections = await typesenseClient.collections().retrieve();
    logger.log(`Found ${collections.length} collections`);
    return collections as TypesenseCollection[];
  } catch (error) {
    logger.error('Error fetching collections from Typesense:', error);
    throw error;
  }
}

// Set up the resource listing request handler
server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  logger.log('Received list resources request: ' + JSON.stringify(request));

  logger.log(`Connecting to Typesense at ${typesenseConfig.protocol}://${typesenseConfig.host}:${typesenseConfig.port}`);

  try {
    const collections = await fetchTypesenseCollections();

    if (collections.length === 0) {
      logger.log('No collections found in Typesense');
      throw new Error('No collections found in Typesense');
    }

    const resources = collections.map((collection: TypesenseCollection) => ({
      uri: new URL(`typesense://collections/${collection.name}`),
      name: collection.name,
      description: `Collection with ${collection.num_documents || 0} documents`
    }));

    logger.log(`Returning ${resources.length} collections as resources`);
    return { resources };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error handling list resources request:', error);
    throw new Error(`Typesense error: ${errorMessage}`);
  }
});

/**
 * Handler for reading a collection's schema or contents.
 * Takes a typesense:// URI and returns the collection info as JSON.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  logger.log('Received read resource request: ' + JSON.stringify(request));
  
  try {
    const url = new URL(request.params.uri);
    const collectionName = url.pathname.replace(/^\/collections\//, "");
    
    if (!collectionName) {
      throw new Error("Invalid collection URI format. Expected: typesense://collections/{collectionName}");
    }
    
    // Get collection schema
    const collectionSchema = await typesenseClient.collections(collectionName).retrieve();
    
    // Get a sample document to infer structure
    let sampleDocument = null;
    try {
      const searchResult = await typesenseClient.collections(collectionName).documents().search({
        q: '*',
        per_page: 1
      });
      
      if (searchResult.hits && searchResult.hits.length > 0) {
        sampleDocument = searchResult.hits[0].document;
      }
    } catch (err) {
      logger.log(`No sample document found for collection ${collectionName}`);
    }
    
    // Build schema information
    const schema = {
      type: "collection",
      name: collectionName,
      fields: collectionSchema.fields || [],
      sample: sampleDocument
    };
    
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(schema, null, 2)
      }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error handling read resource request:', error);
    throw new Error(`Failed to read collection: ${errorMessage}`);
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        "name": "typesense_query",
        "description": "Search for relevant documents in the TypeSense database based on the user's query.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "The search query entered by the user."
            },
            "collection": {
              "type": "string",
              "description": "The name of the TypeSense collection to search within."
            },
            "query_by": {
              "type": "string",
              "description": "Comma-separated fields to search in the collection, e.g., 'title,content'."
            },
            "filter_by": {
              "type": "string",
              "description": "Optional filtering criteria, e.g., 'category:Chatbot'."
            },
            "sort_by": {
              "type": "string",
              "description": "Sorting criteria, e.g., 'created_at:desc'."
            },
            "limit": {
              "type": "integer",
              "description": "The maximum number of results to return.",
              "default": 10
            }
          },
          "required": ["query", "collection", "query_by"]
        }
      },
      {
        "name": "typesense_get_document",
        "description": "Retrieve a specific document by ID from a Typesense collection",
        "inputSchema": {
          "type": "object",
          "properties": {
            "collection": {
              "type": "string",
              "description": "The name of the TypeSense collection"
            },
            "document_id": {
              "type": "string",
              "description": "The ID of the document to retrieve"
            }
          },
          "required": ["collection", "document_id"]
        }
      },
      {
        "name": "typesense_collection_stats",
        "description": "Get statistics about a Typesense collection",
        "inputSchema": {
          "type": "object",
          "properties": {
            "collection": {
              "type": "string",
              "description": "The name of the TypeSense collection"
            }
          },
          "required": ["collection"]
        }
      },
      {
        "name": "typesense_list_collections",
        "description": "List all available Typesense collections with their schemas. Allows zero-conf discovery and routing - the LLM can enumerate collections at runtime and pick the right one(s) before searching. Useful when collections vary by environment, tenant, or version. Returns field definitions for schema inference.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "include_fields": {
              "type": "boolean",
              "description": "Include detailed field schemas for each collection (default: true)",
              "default": true
            }
          }
        }
      }
    ]
  };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  logger.log('Received call tool request: ' + JSON.stringify(request));
  
  // Ensure TypeSense client is initialized
  if (!typesenseClient) {
    if (!typesenseConfig) {
      throw new Error("TypeSense client is not initialized. Please configure it before querying.");
    }
    typesenseClient = initTypesenseClient(typesenseConfig);
  }
  
  switch (request.params.name) {
    case "typesense_query": {
      const { query = "", collection = "", query_by = "", filter_by = "", sort_by = "", limit = 10, exclude_fields = [] } = request.params.arguments || {};
      // Validate required parameters
      if (!query || !collection || !query_by) {
        throw new Error("Missing required parameters: 'query', 'collection', or 'query_by'");
      }
      
      try {
        // Construct TypeSense search query
        const searchParams = {
          q: query as string,
          query_by: query_by as string,
          filter_by: filter_by as string,
          sort_by: sort_by as string,
          per_page: limit as number,
          prefix: false,
          exclude_fields: ['embedding'],
        };
        // Execute TypeSense search
        const response = await typesenseClient.collections(collection as string).documents().search(searchParams);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.hits, null, 2)
          }]
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to query TypeSense collection '${collection}': ${error.message}`);
        }
        throw new Error(`Failed to query TypeSense collection '${collection}': Unknown error`);
      }
    }
    
    case "typesense_get_document": {
      const { collection = "", document_id = "" } = request.params.arguments || {};
      // Validate required parameters
      if (!collection || !document_id) {
        throw new Error("Missing required parameters: 'collection' or 'document_id'");
      }
      
      try {
        // Get document by ID
        const document = await typesenseClient.collections(collection as string).documents(document_id as string).retrieve();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(document, null, 2)
          }]
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to retrieve document '${document_id}' from collection '${collection}': ${error.message}`);
        }
        throw new Error(`Failed to retrieve document '${document_id}' from collection '${collection}': Unknown error`);
      }
    }
    
    case "typesense_collection_stats": {
      const { collection = "" } = request.params.arguments || {};
      // Validate required parameters
      if (!collection) {
        throw new Error("Missing required parameter: 'collection'");
      }

      try {
        // Get collection
        const collectionData = await typesenseClient.collections(collection as string).retrieve();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(collectionData, null, 2)
          }]
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to get stats for collection '${collection}': ${error.message}`);
        }
        throw new Error(`Failed to get stats for collection '${collection}': Unknown error`);
      }
    }

    case "typesense_list_collections": {
      const { include_fields = true } = request.params.arguments || {};

      try {
        // Fetch all collections
        const collections = await typesenseClient.collections().retrieve();

        if (!include_fields) {
          // Return just collection names and basic info
          const basicInfo = collections.map((col: any) => ({
            name: col.name,
            num_documents: col.num_documents || 0,
            created_at: col.created_at
          }));

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                collections: basicInfo,
                count: basicInfo.length
              }, null, 2)
            }]
          };
        }

        // Return full collection details with field schemas
        const detailedCollections = [];
        for (const col of collections) {
          try {
            const collectionDetail = await typesenseClient.collections(col.name).retrieve();
            detailedCollections.push({
              name: collectionDetail.name,
              num_documents: collectionDetail.num_documents || 0,
              created_at: collectionDetail.created_at,
              fields: collectionDetail.fields || [],
              default_sorting_field: collectionDetail.default_sorting_field
            });
          } catch (error) {
            logger.error(`Error fetching details for collection ${col.name}:`, error);
            // Include basic info even if detailed fetch fails
            detailedCollections.push({
              name: col.name,
              num_documents: col.num_documents || 0,
              error: 'Failed to fetch detailed schema'
            });
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              collections: detailedCollections,
              count: detailedCollections.length
            }, null, 2)
          }]
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to list collections: ${error.message}`);
        }
        throw new Error(`Failed to list collections: Unknown error`);
      }
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

/**
 * Handler that lists available prompts.
 * Exposes prompts for analyzing collections.
 */
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "analyze_collection",
        description: "Analyze a Typesense collection structure and contents",
        arguments: [
          {
            name: "collection",
            description: "Name of the collection to analyze",
            required: true
          }
        ]
      },
      {
        name: "search_suggestions",
        description: "Get suggestions for effective search queries for a collection",
        arguments: [
          {
            name: "collection",
            description: "Name of the collection to analyze",
            required: true
          }
        ]
      }
    ]
  };
});

/**
 * Handler for collection analysis prompt.
 * Returns a prompt that requests analysis of a collection's structure and data.
 */
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  logger.log('Received get prompt request: ' + JSON.stringify(request));
  
  const promptName = request.params.name;
  if (!["analyze_collection", "search_suggestions"].includes(promptName)) {
    throw new Error(`Unknown prompt: ${promptName}`);
  }

  const collectionName = request.params.arguments?.collection;
  if (!collectionName) {
    throw new Error("Collection name is required");
  }

  try {
    // Get collection information
    const collection = await typesenseClient.collections(collectionName).retrieve();
    
    // Get a sample of documents to show data distribution
    let sampleDocs: any[] = [];
    try {
      const searchResult = await typesenseClient.collections(collectionName).documents().search({
        q: '*',
        per_page: 5
      });
      
      if (searchResult.hits && searchResult.hits.length > 0) {
        sampleDocs = searchResult.hits.map((hit: any) => hit.document);
      }
    } catch (err) {
      logger.log(`No sample documents found for collection ${collectionName}`);
    }

    if (promptName === "analyze_collection") {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please analyze the following Typesense collection:
Collection: ${collectionName}

Schema:
${JSON.stringify(collection, null, 2)}

Document count: ${collection.num_documents || 'unknown'}

Sample documents:
${JSON.stringify(sampleDocs, null, 2)}`
            }
          },
          {
            role: "user",
            content: {
              type: "text",
              text: "Provide insights about the collection's structure, data types, and how to effectively search it."
            }
          }
        ]
      };
    } 
    
    // If promptName is "search_suggestions"
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please suggest effective search queries for the following Typesense collection:
Collection: ${collectionName}

Fields:
${JSON.stringify(collection.fields, null, 2)}

Sample documents:
${JSON.stringify(sampleDocs, null, 2)}`
          }
        },
        {
          role: "user",
          content: {
            type: "text",
            text: "Based on the collection schema and sample data, suggest effective search queries and parameters that would yield useful results."
          }
        }
      ]
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to analyze collection ${collectionName}: ${error.message}`);
    } else {
      throw new Error(`Failed to analyze collection ${collectionName}: Unknown error`);
    }
  }
});

/**
 * Handler for listing templates.
 * Exposes templates for constructing Typesense queries.
 */
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: [
      {
        name: "typesense_search",
        description: "Template for constructing Typesense search queries",
        uriTemplate: "typesense://collections/{collection}/search",
        text: `To search Typesense collections, you can use these parameters:

Search parameters:
- q: The query text to search for in the documents
- query_by: Comma-separated list of fields to search against
- filter_by: Filter conditions for refining your search results
- sort_by: Fields to sort the results by
- per_page: Number of results to return per page (default: 10)
- page: Page number of results to return (starts at 1)

Example queries:
1. Basic search for "machine learning" in title and content fields:
{
  "q": "machine learning",
  "query_by": "title,content"
}

2. Search with filtering by category:
{
  "q": "neural networks",
  "query_by": "title,content",
  "filter_by": "category:AI"
}

3. Search with custom sorting:
{
  "q": "database",
  "query_by": "title,content",
  "sort_by": "published_date:desc"
}

Use these patterns to construct Typesense search queries.`
      },
      {
        name: "typesense_collection",
        description: "Template for viewing Typesense collection details",
        uriTemplate: "typesense://collections/{collection}",
        text: `This template is used to view details about a Typesense collection.

The URI format follows this pattern:
typesense://collections/{collection_name}

For example:
typesense://collections/products

This will return information about the collection including:
- Field definitions
- Number of documents
- Collection-specific settings
- Schema details`
      }
    ]
  };
});

/**
 * Main function to initialize and run the MCP server
 */
async function main() {
  try {
    typesenseConfig = parseArgs();
    logger.log('Typesense configuration: ' + JSON.stringify(typesenseConfig));

    typesenseClient = initTypesenseClient(typesenseConfig);
    logger.log('Typesense client initialized');

    try {
      const health = await typesenseClient.health.retrieve();
      logger.log('Typesense connection test successful: ' + JSON.stringify(health));
    } catch (error) {
      logger.error('Typesense connection test failed:', error);
    }

    // --- HTTP server wiring (MCP over Streamable HTTP) ---
    const app = express();
    app.use(express.json());

    // Single MCP endpoint – this is your "webserver" entrypoint
    app.post('/', async (req, res) => {
      try {
        // Create a fresh transport per request (avoids request-id collisions)
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,  // stateless
          enableJsonResponse: true       // respond as plain JSON instead of chunks
        });

        res.on('close', () => {
          transport.close();
        });

        // Connect low-level Server to this transport
        await server.connect(transport);
        // Let the transport handle this HTTP request
        await transport.handleRequest(req, res, req.body);
      } catch (err: any) {
        logger.error('Error handling request:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: err?.message ?? 'Internal server error' });
        }
      }
    });

    const port = 3333;
    app.listen(port, () => {
      logger.log(`MCP HTTP server listening at http://localhost:${port}`);
    }).on('error', (error) => {
      logger.error('HTTP server error:', error);
      process.exit(1);
    });

  } catch (error) {
    logger.error('Error running MCP server:', error);
    process.exit(1);
  }
}

main().catch(err => logger.error('Unhandled error:', err));