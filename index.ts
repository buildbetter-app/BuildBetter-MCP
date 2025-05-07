// Imports based on the provided postgres example
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Resource, // Import Resource type if needed for listResources
  Tool,     // Import Tool type if needed for listTools
  Prompt,   // Import Prompt type if needed for listPrompts
  // Add other necessary types from sdk/types.js
} from "@modelcontextprotocol/sdk/types.js";
// Zod is not used in this low-level handler approach, removed import
import {
  GraphQLClient,
  gql,
} from 'graphql-request';
import dotenv from 'dotenv';

// Define a basic type for the introspection result
type IntrospectionResult = any; // Replace with a more specific interface if needed

// Define a basic type for GraphQL schema Type
interface GraphQLType {
  name: string;
  kind: string;
  description?: string | null;
  fields?: GraphQLField[] | null;
}

interface GraphQLField {
  name: string;
  description?: string | null;
  type: GraphQLOutputType;
}

interface GraphQLOutputType {
  kind: string;
  name?: string | null;
  ofType?: GraphQLOutputType | null;
}

dotenv.config();

// cspell:ignore BUILDBETTER
const BUILDBETTER_ENDPOINT = process.env.BUILDBETTER_ENDPOINT || 'https://api-staging.buildbetter.app/v1/graphql';
const BUILDBETTER_API_KEY = process.env.BUILDBETTER_API_KEY;

const graphqlClient = new GraphQLClient(BUILDBETTER_ENDPOINT, {
  headers: {
    ...(BUILDBETTER_API_KEY ? { 'x-buildbetter-api-key': `${BUILDBETTER_API_KEY}` } : {})
  }
});

// Use the lower-level Server class
const server = new Server(
  {
    name: "BuildBetter's Data Explorer",
    version: "0.0.1",
  },
  {
    capabilities: {
      resources: { listChanged: true }, // Assuming listChanged is supported
      tools: { listChanged: true },     // Assuming listChanged is supported
      prompts: { listChanged: true },   // Assuming listChanged is supported
    },
  },
);

// Simple in-memory cache for schema introspection
let cachedSchema: { data: IntrospectionResult; fetchedAt: number } | null = null;
const SCHEMA_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// --- Helper Functions (Keep as they are) ---
async function getSchemaInfo(): Promise<IntrospectionResult> {
  // Return cached schema if still fresh
  if (cachedSchema && Date.now() - cachedSchema.fetchedAt < SCHEMA_CACHE_TTL_MS) {
    return cachedSchema.data;
  }

  const query = gql`
    query IntrospectionQuery {
      __schema {
        types {
          kind
          name
          description
          fields(includeDeprecated: false) {
            name
            description
            type { ...TypeRef }
          }
        }
      }
    }
    fragment TypeRef on __Type {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name }
      }
    }
  `;
  try {
    const data = await graphqlClient.request<IntrospectionResult>(query);
    cachedSchema = { data, fetchedAt: Date.now() };
    return data;
  } catch (error: unknown) {
    console.error('Error fetching schema:', error instanceof Error ? error.message : error);
    throw error;
  }
}

function filterObjectTypes(schema: IntrospectionResult): GraphQLType[] {
  if (!schema || !schema.__schema || !schema.__schema.types) {
    return [];
  }
  return schema.__schema.types.filter((type: any): type is GraphQLType => {
    return !!type && type.kind === 'OBJECT' && !!type.name && !type.name.startsWith('__');
  });
}

function formatTypeForDisplay(type: GraphQLOutputType | null | undefined): string {
  if (!type) return 'Unknown';
  if (type.kind === 'NON_NULL') return `${formatTypeForDisplay(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${formatTypeForDisplay(type.ofType)}]`;
  return type.name || 'UnnamedType';
}

// Helper to fetch field names for given type via introspection
async function getTypeFields(typeName: string): Promise<{ name: string; type: GraphQLOutputType }[]> {
  const query = gql`
    query GetTypeFields($name: String!) {
      __type(name: $name) {
        ... on __Type {
          name
          kind
          fields {
            name
            type { ...TypeRef }
          }
          inputFields {
            name
            type { ...TypeRef }
          }
        }
      }
    }
    fragment TypeRef on __Type {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name ofType { kind name } } # Deeper nesting for complex types
      }
    }
  `;
  const data = await graphqlClient.request<{ __type: any }>(query, { name: typeName });
  const t = data.__type;
  if (!t) return [];
  const fieldsWithType: { name: string; type: GraphQLOutputType }[] = [];
  if (t.fields) {
    fieldsWithType.push(...t.fields.map((f: any) => ({ name: f.name, type: f.type as GraphQLOutputType })));
  }
  if (t.inputFields) {
    fieldsWithType.push(...t.inputFields.map((f: any) => ({ name: f.name, type: f.type as GraphQLOutputType })));
  }
  return fieldsWithType;
}

// Add Levenshtein distance helper to suggest similar field names
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  // increment along the first column of each row
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  // increment each column in the first row
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  // Fill in the rest of the matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

// Suggest similar fields for a given type using Levenshtein distance
async function findSimilarFields(typeName: string, fieldName: string, maxDistance = 3): Promise<string[]> {
  try {
    const fields = await getTypeFields(typeName);
    const fieldNames = fields.map(f => f.name);
    const similar = fieldNames
      .filter(name => {
        const dist = levenshteinDistance(name.toLowerCase(), fieldName.toLowerCase());
        return dist > 0 && dist <= maxDistance;
      })
      .sort((a, b) => (
        levenshteinDistance(a.toLowerCase(), fieldName.toLowerCase()) -
        levenshteinDistance(b.toLowerCase(), fieldName.toLowerCase())
      ));
    return similar;
  } catch (err) {
    console.error('Error finding similar fields:', err);
    return [];
  }
}
// --- End Helper Functions ---

// Shared query templates used by both `query-template` and `nl-query` tools
const queryTemplates: Record<string, (params: any) => string> = {
  "find-person": (params) => {
    const name = params?.name || "";
    return gql`
      query FindPerson {
        person(
          where: {_or: [{first_name: {_ilike: "%${name}%"}}, {last_name: {_ilike: "%${name}%"}}]},
          limit: 5
        ) {
          id
          first_name
          last_name
          email
          title
          company { name }
        }
      }
    `;
  },
  "recent-calls": (params) => {
    const limit = params?.limit || 10;
    return gql`
      query RecentCalls {
        interview(
          order_by: {display_ts: desc},
          limit: ${limit}
        ) {
          id
          name
          display_ts
          recorded_at
          short_summary
          attendees {
            person {
              first_name
              last_name
            }
          }
        }
      }
    `;
  },
  "call-with-topic": (params) => {
    const topic = params?.topic || "";
    const limit = params?.limit || 5;
    return gql`
      query CallsWithTopic {
        extraction(
          where: {
            summary: {_ilike: "%${topic}%"}
          },
          order_by: {display_ts: desc},
          limit: ${limit}
        ) {
          id
          summary
          display_ts
          call {
            id
            name
            display_ts
            recorded_at
          }
        }
      }
    `;
  },
  "signal-by-type": (params) => {
    const type = params?.type || "issue";
    const limit = params?.limit || 10;
    const days = params?.days;
    let dateFilter = "";
    if (days && Number.isInteger(days) && days > 0) {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
      dateFilter = `, display_ts: {_gte: "${sinceDate.toISOString()}"}`;
    }
    return gql`
      query SignalsByType {
        extraction(
          where: {
            types: {
              type: {
                name: {_eq: "${type}"}
              }
            }
            ${dateFilter}
          },
          order_by: {display_ts: desc},
          limit: ${limit}
        ) {
          id
          summary
          display_ts
          sentiment
          call {
            name
          }
        }
      }
    `;
  }
};

// --- Resource Handlers ---
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // For now, let's list the two main resources we defined conceptually
  const resources: Resource[] = [ // Explicitly type as Resource[]
      {
        uri: "graphql://schema",
        name: "GraphQL Schema Overview",
        description: "List of all available object types in the schema.",
        mimeType: "text/markdown"
      },
      {
        uri: "graphql://guide/context",
        name: "BuildBetter Context Guide",
        description: "Strategies, query patterns, and best practices for building rich context with BuildBetter GraphQL data.",
        mimeType: "text/markdown"
      },
      {
        uri: "graphql://docs/schema-relationships",
        name: "Schema Relationships Cheat-Sheet",
        description: "Markdown diagram of key entities and how they connect (interview, extraction, extraction_type, joins, person, company).",
        mimeType: "text/markdown"
      },
      {
        uri: "graphql://examples/common-queries",
        name: "Common Query Examples",
        description: "Ready-to-use GraphQL snippets for frequent BuildBetter data tasks.",
        mimeType: "text/markdown"
      },
      // Add more static resources or handle dynamic ones in ReadResource if needed
      {
        uri: "graphql://guide/practical-examples",
        name: "Practical Query Examples",
        description: "Ready-to-use examples for the most common scenarios with BuildBetter data",
        mimeType: "text/markdown"
      }
    ];
  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const parsedUri = new URL(uri);

  if (parsedUri.protocol === "graphql:") {
    if (parsedUri.pathname === "//schema") {
      // Handle reading the schema list resource
      try {
        const schema = await getSchemaInfo();
        const objectTypes = filterObjectTypes(schema);
        const content = objectTypes.map((type: GraphQLType) =>
          `# ${type.name}\n${type.description ? type.description + '\n' : ''}`
        ).join('\n\n');
        return { contents: [{ uri: uri, mimeType: "text/markdown", text: content }] };
      } catch (error: unknown) {
        // Return a valid ReadResourceResult structure even on error
        return { contents: [{ uri: uri, text: `Error fetching schema: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    } else if (parsedUri.pathname.startsWith("//type/")) {
      // Handle reading a specific type resource
      const typeName = parsedUri.pathname.substring("//type/".length);
       if (!typeName) {
         // Return a valid ReadResourceResult structure
         return { contents: [{ uri: uri, text: "Error: Type name missing in URI." }] };
       }
      try {
        const schema = await getSchemaInfo();
        const objectTypes = filterObjectTypes(schema);
        const selectedType = objectTypes.find((type: GraphQLType) => type.name === typeName);
        if (!selectedType) {
          // Return a valid ReadResourceResult structure
          return { contents: [{ uri: uri, text: `Type "${typeName}" not found in schema.` }] };
        }
        let content = `# ${selectedType.name}\n\n${selectedType.description ? selectedType.description + '\n\n' : ''}## Fields\n\n`;
        if (selectedType.fields && selectedType.fields.length > 0) {
          selectedType.fields.forEach((field: GraphQLField) => {
            content += `### ${field.name}\n**Type:** ${formatTypeForDisplay(field.type)}\n${field.description ? `**Description:** ${field.description}\n` : ''}\n`;
          });
        } else {
          content += "No fields available.\n";
        }
        return { contents: [{ uri: uri, mimeType: "text/markdown", text: content }] };
      } catch (error: unknown) {
         // Return a valid ReadResourceResult structure
        return { contents: [{ uri: uri, text: `Error fetching type ${typeName}: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    } else if (parsedUri.pathname === "//guide/context") {
      // Return the static context-building guide markdown
      const guide = `# BuildBetter GraphQL Context Guide

## 1. Schema Understanding and Navigation
Use introspection queries to confirm field availability before issuing complex queries. Example:

\`\`\`graphql
query SchemaExploration($type: String!) {
  __type(name: $type) { name fields { name type { name kind } } }
}
\`\`\`

## 2. Standard Query Patterns
- Recent Calls Context
- Call Detail Context
- Signal Context

## 3. Context-Building Strategies
1. Chronological Context → calls → details → signals.
2. Issue Context → signals by type → group themes.
3. Customer Context → company/person → calls → signals.
4. Relationship Context → connect issues across calls.

## 4. Query Template Examples
• Customer Issue Investigation
• Product Feedback Collection
• Cross-Call Theme Analysis

## 5. Response Transformation
Group related signals, establish temporal context, extract actionable insights, enrich with relationship data.

## 6. Error Handling Strategies
Schema exploration first, fallback patterns, pagination, field validation cache.

_For full details see project documentation._

## Persona Cheat-Sheet

| Purpose | persona.name | persona_id |
|---------|--------------|------------|
| Customer | Customer | 246 |
| Team Member | Team Member | 247 |

Use persona_id to filter speaker person in queries. Example:

\`\`\`graphql
query CustomerObjections($start: timestamptz!) {
  extraction_type_join(
    where: {
      type: {_eq: objection}
      extraction: {
        created_at: {_gte: $start}
        speaker: { person: { persona_id: {_in: [246]} } }
      }
    },
    order_by: { extraction: { created_at: desc } },
    limit: 20
  ) {
    extraction { id summary created_at }
  }
}
\`\`\`
`;
      return { contents: [{ uri: uri, mimeType: "text/markdown", text: guide }] };
    } else if (parsedUri.pathname === "//docs/schema-relationships") {
      const schemaRelationshipsMd = `# BuildBetter Schema Relationships

\`\`\`mermaid
flowchart TB
  interview -->|has many| interview_monologue
  interview -->|has many| extraction
  interview -->|has many| interview_attendee
  extraction -->|many-to-many| extraction_type_join_table["extraction_type_join (join table)"]
  extraction_type_join_table --o|links to| extraction
  extraction_type_join_table --o|links to| extraction_type
  extraction -->|many-to-many| extraction_topic_join_table["extraction_topic_join (join table)"]
  extraction_topic_join_table --o|links to| extraction
  extraction_topic_join_table --o|links to| extraction_topic["extraction_topic (e.g. 'pricing')"]
  extraction -->|many-to-many| extraction_emotion_join_table["extraction_emotion_join (join table)"]
  extraction_emotion_join_table --o|links to| extraction
  extraction_emotion_join_table --o|links to| extraction_emotion["extraction_emotion (e.g. 'positive')"]
  interview_attendee --> person
  person --> company
  extraction --> interview_monologue
  extraction --> call["interview (synonym: call)"]
\`\`\`

## Key Query Paths for Common Tasks

### 1. Find a person's recent calls:
Path: \`person\` → \`interview_attendees\` (filter by person_id) → \`interview\` (order by \`display_ts\` desc)
Example:
\`\`\`graphql
query PersonRecentCalls($personId: uuid!) {
  person_by_pk(id: $personId) {
    first_name
    last_name
    interview_attendees(order_by: {interview: {display_ts: desc}}, limit: 5) {
      interview { id name display_ts }
    }
  }
}
\`\`\`

### 2. Find extractions (signals) of a specific type:
Path: \`extraction\` where \`types\` (this is likely the join table \`extraction_type_join\`) → \`type\` (this is \`extraction_type\`) → \`name\` equals your type.
Example:
\`\`\`graphql
query ExtractionsByType($typeName: String = "Issue") {
  extraction(
    where: { extraction_type_joins: { extraction_type: { name: {_eq: $typeName} } } }
    order_by: {display_ts: desc}
    limit: 10
  ) {
    id summary display_ts
    extraction_type_joins { extraction_type { name } } # To confirm type
  }
}
\`\`\`
*Note: The exact join path might be \`extraction_type_joins: { extraction_type: { name: ... } }\` or similar depending on schema specifics.*

### 3. Find calls (interviews) discussing a topic:
Path: \`extraction\` where \`summary\` (or other text field) contains topic → \`call\` (or \`interview\`)
Example:
\`\`\`graphql
query InterviewsByTopic($topicSubstring: String = "integration") {
  extraction(
    where: { summary: {_ilike: $topicSubstring} }
    order_by: {display_ts: desc}
    limit: 5
  ) {
    summary
    call { id name display_ts } # Assuming 'call' is the field linking to interview
  }
}
\`\`\`

### 4. Find all attendees of a call (interview):
Path: \`interview\` → \`attendees\` (this is \`interview_attendee\`) → \`person\`
Example:
\`\`\`graphql
query InterviewAttendees($interviewId: uuid!) {
  interview_by_pk(id: $interviewId) {
    name
    attendees {
      person { first_name last_name email }
    }
  }
}
\`\`\`

## Common Field Name Reference & Notes

- **Primary Text Content**: For \`extraction\`, this is often in a field named \`summary\` or \`text\`.
- **Timestamps**: Use \`display_ts\` for consistent user-facing ordering. \`created_at\` and \`updated_at\` are also common.
- **Filtering Extractions by Type**: The typical path involves a join table (e.g., \`extraction_type_join\`) linking \`extraction\` to \`extraction_type\`. The filter would be on \`extraction_type.name\`. Example: \`where: { extraction_type_joins: { extraction_type: { name: {_eq: "Issue"} } } }\`.
- **Linking Extractions to Calls**: An \`extraction\` usually has a foreign key like \`call_id\` or \`interview_id\` linking it back to the main \`interview\` (or \`call\`) record.
- **Persons and Companies**: \`person\` records often link to a \`company\` via \`company_id\`. An \`interview_attendee\` links an \`interview\` to a \`person\`.

*Always verify exact field and table names against your specific schema using introspection tools or by examining query results.*
`;
      return { contents: [{ uri, mimeType: "text/markdown", text: schemaRelationshipsMd }] };
    } else if (parsedUri.pathname === "//examples/common-queries") {
      const md = `# Common BuildBetter Queries\n\n## Recent Issues\n\n\`\`\`graphql\nquery RecentIssues {\n  extraction(\n    where: {\n      extraction_type_joins: { extraction_type: { name: {_eq: \"Issue\"} } }\n    },\n    order_by: { created_at: desc },\n    limit: 20\n  ) {\n    id\n    text\n    created_at\n    interview { id name created_at }\n  }\n}\n\`\`\`\n\n## Feature Requests (last 30 days)\n\n\`\`\`graphql\nquery RecentFeatureRequests {\n  extraction(\n    where: {\n      extraction_type_joins: { extraction_type: { name: {_eq: \"Feature Request\"} } },\n      created_at: { _gte: \"2025-05-01\" }\n    }\n  ) { id text interview { name } }\n}\n\`\`\`\n\n## Filter Extractions by Keyword\n\n\`\`\`graphql\nquery SearchExtractions($keyword: String!) {\n  extraction(where: { text: {_ilike: $keyword} }) { id text interview { name } }\n}\n\`\`\`\n`;
      return { contents: [{ uri, mimeType: "text/markdown", text: md }] };
    } else if (parsedUri.pathname === "//guide/practical-examples") {
      const practicalExamplesMd = `# Practical BuildBetter Query Examples

## 1. Last call with a specific person (by name)

Replace \`%NAME%\` with the actual name or part of the name.
Replace \`YYYY-MM-DD\` with a specific date if needed.

\`\`\`graphql
query FindPersonConversations {
  person(
    where: {_or: [{first_name: {_ilike: "%NAME%"}}, {last_name: {_ilike: "%NAME%"}}]},
    limit: 1 # Find one person matching
  ) {
    id
    first_name
    last_name
    # Get the single most recent interview this person attended
    interview_attendees(order_by: {interview: {display_ts: desc}}, limit: 1) {
      interview {
        id
        name
        display_ts
        recorded_at
        short_summary
      }
    }
  }
}
\`\`\`

## 2. Top customer issues (last 30 days)

This query assumes:
- Extractions of type "issue" represent customer issues.
- \`display_ts\` is the relevant timestamp on extractions.
- \`summary\` contains the issue text.
- Extractions link to a \`call\` (interview).

\`\`\`graphql
query TopCustomerIssues($since: timestamptz = "YYYY-MM-DD") { # Set YYYY-MM-DD to 30 days ago
  extraction(
    where: {
      types: { # Path to extraction type name
        type: {
          name: {_eq: "issue"} # Ensure 'issue' is the exact type name
        }
      },
      display_ts: {_gte: $since}
    },
    order_by: {display_ts: desc},
    limit: 10
  ) {
    id
    summary
    display_ts
    sentiment
    call { # Link to the call/interview
      name
    }
  }
}
\`\`\`
*To get the date for 30 days ago, you can calculate it in your client or use a dynamic variable if your GraphQL server supports it.*

## 3. Calls discussing a specific topic

Replace \`%TOPIC%\` with the keyword or phrase. This searches the \`summary\` field of extractions.

\`\`\`graphql
query FindCallsByTopic($topicSearch: String = "%TOPIC%") {
  extraction(
    where: {
      summary: {_ilike: $topicSearch}
    },
    order_by: {display_ts: desc},
    limit: 5 # Limit the number of extractions found
  ) {
    id
    summary
    display_ts
    call { # Link to the call/interview
      id
      name
      display_ts
      recorded_at
    }
  }
}
\`\`\`
*Note: This returns extractions related to the topic, and through them, the associated calls. If you need unique calls, client-side processing or a more complex query (e.g., using distinct_on with call_id) might be needed.*

**Important Considerations:**
- **Field Names:** The field names used (\`first_name\`, \`last_name\`, \`interview_attendees\`, \`interview\`, \`display_ts\`, \`recorded_at\`, \`short_summary\`, \`extraction\`, \`types\`, \`type\`, \`name\`, \`summary\`, \`sentiment\`, \`call\`) are examples. **Verify these against your specific BuildBetter GraphQL schema.** Use the \`list-types\` and \`find-fields\` tools.
- **Placeholders:** Replace placeholders like \`%NAME%\`, \`%TOPIC%\`, and date strings (\`YYYY-MM-DD\`) with actual values or GraphQL variables.
- **Limits:** Adjust \`limit\` clauses based on how much data you need.
- **Error Handling:** These examples do not include error handling, which should be implemented in client applications.
`;
      return { contents: [{ uri, mimeType: "text/markdown", text: practicalExamplesMd }] };
    }
  }

  // If URI doesn't match known patterns, throw a standard MCP error
   throw { code: -32002, message: "Resource not found", data: { uri } };
});
// --- End Resource Handlers ---


// --- Tool Handlers ---
const toolsList: Tool[] = [ // Explicitly type as Tool[]
  {
    name: "run-query",
    description: "Execute a read-only GraphQL query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The GraphQL query to execute" },
        variables: { type: "object", description: "Optional variables for the query" }
      },
      required: ["query"]
    }
  },
  {
    name: "list-types",
    description: "Get a list of available GraphQL object types (excluding internal ones)",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "build-query",
    description: "Build a simple GraphQL query string for a specific type",
    inputSchema: {
      type: "object",
      properties: {
        typeName: { type: "string", description: "The name of the GraphQL type to query" },
        fields: { type: "array", items: { type: "string" }, description: "Fields to include in the query" },
        limit: { type: "number", description: "Optional limit for the number of results (must be positive integer)" },
        filter: { type: "object", description: "Optional filter criteria (structure depends on schema)" }
      },
      required: ["typeName", "fields"]
    }
  },
  {
    name: "schema-overview",
    description: "Return a markdown cheat-sheet describing key schema relationships (mermaid diagram).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "search-extractions",
    description: "Search extractions (signals) by keyword/phrase with optional extraction type filter and limit",
    inputSchema: {
      type: "object",
      properties: {
        phrase: { type: "string", description: "Text to search for (case-insensitive)" },
        type: { type: "string", description: "Extraction type name to filter by (optional)" },
        limit: { type: "number", description: "Maximum number of results to return (optional)" },
        personaIds: { type: "array", items: { type: "number" }, description: "List of persona_id to filter speaker person by (optional)" }
      },
      required: ["phrase"]
    }
  },
  {
    name: "find-fields",
    description: "Return the field names for a specified GraphQL type (object or input object)",
    inputSchema: {
      type: "object",
      properties: {
        typeName: { type: "string", description: "GraphQL type name" }
      },
      required: ["typeName"]
    }
  },
  {
    name: "open-resource",
    description: "Fetch a static resource by URI returned from ListResources",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "Resource URI (must match ListResources)" }
      },
      required: ["uri"]
    }
  },
  {
    name: "read-resource",
    description: "Alias of open-resource to fetch a static resource by URI",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string", description: "Resource URI (must match ListResources)" } },
      required: ["uri"]
    }
  },
  // Knowledge-graph tools -----------------------------
  // open_nodes tool removed
  {
    name: "recent-conversation-with",
    description: "Find the most recent conversation with a specific person by name",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "First or last name of the person to find" },
        limit: { type: "number", description: "Optional: Maximum number of conversations to return (default: 1)" }
      },
      required: ["name"]
    }
  },
  {
    name: "top-customer-issues",
    description: "Get the most common customer issues from extractions/signals",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Optional: Number of issues to return (default: 10)" },
        days: { type: "number", description: "Optional: Only include issues from the last N days (default: 30)" }
      }
    }
  },
  {
    name: "topic-conversations",
    description: "Find conversations discussing a specific topic",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic/keyword to search for" },
        limit: { type: "number", description: "Optional: Maximum number of conversations to return (default: 5)" }
      },
      required: ["topic"]
    }
  },
  {
    name: "query-template",
    description: "Generate a query from predefined templates for common tasks",
    inputSchema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description: "Template name: find-person, recent-calls, call-with-topic, signal-by-type, etc."
        },
        parameters: {
          type: "object",
          description: "Parameters for the template (depends on template chosen)"
        }
      },
      required: ["template"]
    }
  },
  {
    name: "validate-query",
    description: "Check if a GraphQL query is valid before executing it",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The GraphQL query to validate" }
      },
      required: ["query"]
    }
  }, // Added comma after validate-query
  {
    name: "nl-query",
    description: "Generate a GraphQL query from a natural language description",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Natural language description of what you want to query" }
      },
      required: ["description"]
    }
  },
  {
    name: "help",
    description: "Get help on using BuildBetter MCP effectively",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string", description: "Optional specific topic to get help on" } }
    }
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: toolsList };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments || {};

  if (toolName === "run-query") {
    const query = args?.query as string;
    const variables = args?.variables as Record<string, any> | undefined;

    if (!query) {
       return { content: [{ type: "text", text: "Error: 'query' argument is required." }], isError: true };
    }

    const queryText = query.trim().toLowerCase();
    if (queryText.startsWith('mutation') || queryText.includes('mutation {')) {
      return { content: [{ type: "text", text: "Error: Only read-only queries are allowed." }], isError: true };
    }
    try {
      const result: any = await graphqlClient.request(query, variables);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Look for common errors and provide helpful suggestions
      if (errorMsg.includes("field not found") || errorMsg.includes("Cannot query field")) { // Added common alternative phrasing
        // Try to extract the field name from error
        const fieldMatch = errorMsg.match(/field '([^']+)' not found/) || errorMsg.match(/Cannot query field "([^"]+)" on type/);
        const typeMatch = errorMsg.match(/on type ['\"]([^'\"]+)['\"]/);
        const fieldName = fieldMatch && fieldMatch[1] ? fieldMatch[1] : "unknown";
        const typeName = typeMatch && typeMatch[1] ? typeMatch[1] : null;

        let similarFieldsSuggestion = "Use the 'find-fields' tool to check available fields.";
        if (typeName) {
          const similar = await findSimilarFields(typeName, fieldName);
          if (similar.length > 0) {
            similarFieldsSuggestion = `Did you mean: ${similar.slice(0, 3).join(', ')}?`;
          }
        }

        return {
          content: [{
            type: "text",
            text: `Error: Field '${fieldName}' not found or not queryable on the specified type${typeName ? ` '${typeName}'` : ''}. ${similarFieldsSuggestion} Original error: ${errorMsg}`
          }],
          isError: true
        };
      }
      
      // Generic error handling
      return {
        content: [{ type: "text", text: `Error executing query: ${errorMsg}` }],
        isError: true
      };
    }
  } else if (toolName === "list-types") {
     try {
      const schema = await getSchemaInfo();
      const objectTypes = filterObjectTypes(schema);
      const typeNames = objectTypes.map((type: GraphQLType) => type.name);
      return { content: [{ type: "text", text: JSON.stringify(typeNames, null, 2) }] };
    } catch (error: unknown) {
      return { content: [{ type: "text", text: `Error fetching types: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  } else if (toolName === "build-query") {
    const typeName = args?.typeName as string;
    const fields = args?.fields as string[] | undefined;
    const limit = args?.limit as number | undefined;
    const filter = args?.filter as Record<string, any> | undefined;

    if (!typeName || !fields || fields.length === 0) {
       return { content: [{ type: "text", text: "Error: 'typeName' and 'fields' arguments are required." }], isError: true };
    }

    try {
      const schema = await getSchemaInfo();
      const objectTypes = filterObjectTypes(schema);
      const selectedType = objectTypes.find((type: GraphQLType) => type.name === typeName);
      if (!selectedType) {
        return { content: [{ type: "text", text: `Error: Type "${typeName}" not found.` }], isError: true };
      }
      const validFields = selectedType.fields?.map((f: GraphQLField) => f.name) ?? [];
      const invalidFields = fields.filter(f => !validFields.includes(f));
      if (invalidFields.length > 0) {
        return { content: [{ type: "text", text: `Error: Invalid fields for "${typeName}": ${invalidFields.join(', ')}` }], isError: true };
      }
      let queryParams = '';
      const params = [];
      if (limit !== undefined && Number.isInteger(limit) && limit > 0) params.push(`first: ${limit}`);
      if (filter && Object.keys(filter).length > 0) {
        const filterStr = Object.entries(filter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
        if (filterStr) params.push(`where: {${filterStr}}`);
      }
      if (params.length > 0) queryParams = `(${params.join(', ')})`;
      const queryName = selectedType.name.charAt(0).toLowerCase() + selectedType.name.slice(1) + 's';
      const queryString = `query Get${selectedType.name} { ${queryName}${queryParams} { ${fields.join('\n    ')} } }`;
      return { content: [{ type: "text", text: queryString.trim() }] };
    } catch (error: unknown) {
      return { content: [{ type: "text", text: `Error building query: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  } else if (toolName === "schema-overview") {
    // Simply return the markdown from the static resource so the client can render it
    const mdUri = "graphql://docs/schema-relationships";
    return { content: [{ type: "resource", uri: mdUri }] };
  } else if (toolName === "search-extractions") {
    const phrase = args?.phrase as string;
    const extType = args?.type as string | undefined;
    const limit = args?.limit as number | undefined;
    const personaIds = args?.personaIds as number[] | undefined;
    if (!phrase) {
      return { content: [{ type: "text", text: "Error: 'phrase' argument is required." }], isError: true };
    }

    // --- Determine usable fields dynamically via introspection ---

    // 1. Decide which text-like field exists on the `extraction` object for filtering **and** selection
    const candidateTextFields = [
      "text",
      "summary",
      "context",
      "exact_quote",
      "content",
    ];
    const extractionFields = await getTypeFields("extraction");
    const textField = candidateTextFields.find((f) => extractionFields.some(ef => ef.name === f));
    if (!textField) {
      return {
        content: [
          { type: "text", text: "Error: Could not determine a text field on the 'extraction' type." },
        ],
        isError: true,
      };
    }

    // 2. Find a join field we can use for filtering by extraction type (if requested)
    const candidateJoinFields = [
      "extraction_type_joins",
      "extraction_types",
      "extraction_type_links",
      "types",
    ];
    const boolFieldsAll = await getTypeFields("extraction_bool_exp");
    const joinFieldForFilter = candidateJoinFields.find((f) => boolFieldsAll.some(bf => bf.name === f)) || null;

    // 3. Choose a join field for selection so the resulting JSON has type names – use the same name if it exists on the object
    const joinFieldForSelection = candidateJoinFields.find((f) => extractionFields.some(ef => ef.name === f)) || null;

    // --- Build query pieces ---
    // Smart Defaults for text search: search in multiple candidate fields
    const smartSearchableFields = ["summary", "exact_quote", "text", "context"]
      .filter(fieldName => extractionFields.some(ef => ef.name === fieldName));

    let whereTextCondition;
    if (smartSearchableFields.length > 0) {
      const orConditions = smartSearchableFields.map(field =>
        `{ ${field}: {_ilike: "%${phrase}%"} }` // Each condition is an object
      ).join(", ");
      whereTextCondition = smartSearchableFields.length > 1
        ? `_or: [${orConditions}]`
        : orConditions.slice(2, -2); // Remove surrounding { } if only one field
    } else if (textField) { // Fallback to the single textField if smart fields aren't found (should not happen if textField logic is sound)
      whereTextCondition = `${textField}: {_ilike: "%${phrase}%"}`;
    } else {
      // This case should ideally be prevented by the textField check earlier
      return { content: [{ type: "text", text: "Error: No searchable text field found for extractions." }], isError: true };
    }
    
    const limitClause = limit && Number.isInteger(limit) && limit > 0 ? `, limit: ${limit}` : "";

    const joinFilter = extType && joinFieldForFilter
      ? `${joinFieldForFilter}: { extraction_type: { name: {_eq: \"${extType}\"} } }`
      : "";
    
    // Combine text search, join filter, and potentially other conditions
    const allWhereConditions = [whereTextCondition, joinFilter].filter(Boolean);
    let whereCombined = allWhereConditions.join(", ");


    // include interview relation only if present on extraction type
    // This logic seems to try to force an interview relation, which might not be what's intended.
    // Commenting out for now as it might be overly restrictive or incorrect without more context.
    // if (extractionFields.some(f => f.name === "interview")) {
    //   whereCombined = whereCombined ? `${whereCombined}, interview: { id: {_is_null: false} }` : "interview: { id: {_is_null: false} }";
    // }
    // Instead, let's ensure the base 'where' conditions are correctly structured if multiple exist
    if (allWhereConditions.length > 1) {
       // If we have multiple top-level conditions (e.g. _or from text search AND a joinFilter)
       // they should typically be siblings in the where object, or under an _and if necessary.
       // For now, simple comma separation assumes they are sibling properties.
       // If more complex logic (like _and) is needed, this needs refinement.
    }


    // include personaIds filter
    if (personaIds && personaIds.length > 0 && extractionFields.some(f => f.name === "speaker")) {
      const personaFilter = `speaker: { person: { persona_id: {_in: [${personaIds.join(',')}]} } }`;
      whereCombined = whereCombined ? `${whereCombined}, ${personaFilter}` : personaFilter;
    }

    // Final check for an empty whereCombined, which is invalid GraphQL
    if (!whereCombined.trim()) {
        // If phrase was the only thing and it didn't find fields, or other logic paths lead here.
        // We might default to a less restrictive query or return an error.
        // For now, let's assume if phrase is given, whereCombined will be non-empty.
        // If it can be empty, an error or default (like empty where: {}) might be needed.
    }


    // include interview relation only if present on extraction type
    if (extractionFields.some(f => f.name === "interview")) {
      // This was previously modifying whereCombined.
      // It's more about what's *selected* than filtered, unless the intent was to only get extractions *with* interviews.
      // The selection part handles adding interview fields.
      // If the filter `interview: { id: {_eq: true} }` was intentional, it should be part of the `allWhereConditions` logic.
      // For now, I'm removing its modification to `whereCombined` here as it was unclear and potentially problematic.
      // The original line was:
      // whereCombined = whereCombined ? `${whereCombined}, interview: { id: {_eq: true} }` : "interview: { id: {_eq: true} }";
    }

    // include join relation and map to correct nested field name
    if (joinFieldForSelection) {
      // Determine nested field (some schemas use 'type', others 'extraction_type')
      const joinNestedFields = await getTypeFields("extraction_type_join");
      const nestedFieldName = joinNestedFields.some(f => f.name === "extraction_type") ? "extraction_type" : joinNestedFields.some(f => f.name === "type") ? "type" : null;
      if (nestedFieldName) {
        whereCombined = whereCombined ? `${whereCombined}, ${joinFieldForSelection} { ${nestedFieldName} { name } }` : `${joinFieldForSelection} { ${nestedFieldName} { name } }`;
      }
    }

    // include personaIds filter
    if (personaIds && personaIds.length > 0 && extractionFields.some(f => f.name === "speaker")) {
      whereCombined = whereCombined ? `${whereCombined}, speaker: { person: { persona_id: {_in: [${personaIds.join(',')}]} } }` : `speaker: { person: { persona_id: {_in: [${personaIds.join(',')}]} } }`;
    }

    const selectionFields: string[] = ["id", textField, "created_at"];

    // include interview relation only if present on extraction type
    if (extractionFields.some(f => f.name === "interview")) {
      selectionFields.push("interview { id name created_at }");
    }

    // include join relation and map to correct nested field name
    if (joinFieldForSelection) {
      // Determine nested field (some schemas use 'type', others 'extraction_type')
      const joinNestedFields = await getTypeFields("extraction_type_join");
      const nestedFieldName = joinNestedFields.some(f => f.name === "extraction_type") ? "extraction_type" : joinNestedFields.some(f => f.name === "type") ? "type" : null;
      if (nestedFieldName) {
        selectionFields.push(`${joinFieldForSelection} { ${nestedFieldName} { name } }`);
      }
    }

    const selectionBlock = selectionFields.join("\n    ");

    const queryString = `query SearchExtractions {\n  extraction(\n    where: { ${whereCombined} }\n    order_by: { created_at: desc }${limitClause}\n  ) {\n    ${selectionBlock}\n  }\n}`;

    // Attempt execution
    try {
      const result = await graphqlClient.request(queryString);
      return {
        content: [
          {
            type: "text",
            text: "Executed query:\n\n```graphql\n" + queryString + "\n```",
          },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error: unknown) {
      return {
        content: [
          {
            type: "text",
            text: `Error executing search: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  } else if (toolName === "recent-conversation-with") {
    const name = args?.name as string;
    const limit = args?.limit as number | undefined || 1;
    
    if (!name) {
      return { content: [{ type: "text", text: "Error: 'name' argument is required." }], isError: true };
    }
    
    try {
      const query = gql`
        query FindPersonConversations($nameParam: String = "${name}", $limitParam: Int = ${limit}) { # Using gql tag and variables
          person(
            where: {_or: [{first_name: {_ilike: $nameParam}}, {last_name: {_ilike: $nameParam}}]},
            limit: 5 # Limit for persons found
          ) {
            id
            first_name
            last_name
            interview_attendees(order_by: {interview: {display_ts: desc}}, limit: $limitParam) { # Limit for conversations per person
              interview {
                id
                name
                display_ts
                recorded_at
                short_summary
              }
            }
          }
        }
      `;
      // Construct variables for the query, ensuring nameParam is wrapped in % for ilike
      const variables = {
        nameParam: `%${name}%`,
        limitParam: limit
      };
      
      const result = await graphqlClient.request(query, variables);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error finding conversations with ${name}: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  } else if (toolName === "top-customer-issues") {
    const limit = args?.limit as number | undefined || 10;
    const days = args?.days as number | undefined || 30;
    const issueType = "issue"; // Assuming "issue" is the correct type name

    try {
      let dateFilterString = "";
      const variables: { limitParam: number; issueTypeParam: string; sinceDateParam?: string } = {
        limitParam: limit,
        issueTypeParam: issueType
      };

      if (days && Number.isInteger(days) && days > 0) {
        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - days);
        variables.sinceDateParam = sinceDate.toISOString();
        dateFilterString = `display_ts: {_gte: $sinceDateParam}`;
      }

      const query = gql`
        query TopCustomerIssues($limitParam: Int!, $issueTypeParam: String!, $sinceDateParam: timestamptz) {
          extraction(
            where: {
              types: { type: { name: {_eq: $issueTypeParam} } }
              ${dateFilterString ? `, ${dateFilterString}` : ''} # Add date filter if applicable
            },
            order_by: {display_ts: desc},
            limit: $limitParam
          ) {
            id
            summary # Or 'text' or other relevant field
            display_ts
            sentiment
            call { # Assuming 'call' links to interview/call details
              id
              name
            }
          }
        }
      `;
      
      const result = await graphqlClient.request(query, variables);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error fetching top customer issues: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  } else if (toolName === "topic-conversations") {
    const topic = args?.topic as string;
    const limit = args?.limit as number | undefined || 5;

    if (!topic) {
      return { content: [{ type: "text", text: "Error: 'topic' argument is required." }], isError: true };
    }

    try {
      const variables = {
        topicParam: `%${topic}%`, // For _ilike
        limitParam: limit
      };
      const query = gql`
        query CallsWithTopic($topicParam: String!, $limitParam: Int!) {
          extraction(
            where: {
              summary: {_ilike: $topicParam} # Assuming summary is the target field
            },
            order_by: {display_ts: desc}, # Assuming display_ts for ordering
            limit: $limitParam
          ) {
            id
            summary # Or text
            display_ts
            call { # Assuming 'call' links to interview/call details
              id
              name
              display_ts
              recorded_at
            }
          }
        }
      `;
      
      const result = await graphqlClient.request(query, variables);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error finding conversations about '${topic}': ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  } else if (toolName === "query-template") {
    const templateName = args?.template as string;
    const parameters = args?.parameters as Record<string, any> | undefined || {};
    if (!templateName) {
      return { content: [{ type: "text", text: "Error: 'template' argument is required." }], isError: true };
    }
    if (!queryTemplates[templateName]) {
      return {
        content: [{ type: "text", text: `Template '${templateName}' not found. Available templates: ${Object.keys(queryTemplates).join(", ")}` }],
        isError: true
      };
    }
    try {
      const queryStr = queryTemplates[templateName](parameters);
      return { content: [{ type: "text", text: queryStr }] };
    } catch (error: unknown) {
      return {
        content: [{ type: "text", text: `Error generating query from template '${templateName}': ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  } else if (toolName === "find-fields") {
    const typeName = args?.typeName as string;
    if (!typeName) {
      return { content: [{ type: "text", text: "Error: 'typeName' argument is required." }], isError: true };
    }
    try {
      const fields = await getTypeFields(typeName); // Renamed from names to fields
      if (fields.length === 0) {
        return { content: [{ type: "text", text: `Type '${typeName}' not found or has no fields.` }] };
      }
      // Updated to include field types using formatTypeForDisplay
      const fieldsWithTypes = fields.map(field => `${field.name}: ${formatTypeForDisplay(field.type)}`).join('\n');
      return { content: [{ type: "text", text: `Fields for ${typeName}:\n\n` + fieldsWithTypes }] };
    } catch (error: unknown) {
      return { content: [{ type: "text", text: `Error introspecting type: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  } else if (toolName === "validate-query") {
    const query = args?.query as string;
    if (!query) {
      return { content: [{ type: "text", text: "Error: 'query' argument is required." }], isError: true };
    }
    try {
      // Basic syntax validation via gql tag
      gql`${query}`;

      const lower = query.trim().toLowerCase();
      if (lower.startsWith("mutation") || lower.includes("mutation {")) {
        return { content: [{ type: "text", text: "Query validation failed: Mutations are not allowed." }], isError: true };
      }

      // Extract operation type and first-level field selections
      const opMatch = query.match(/^(query|subscription)\s*[\w\s]*\{([\s\S]*)\}$/i);
      if (opMatch) {
        const opType = opMatch[1].toLowerCase();
        const inner = opMatch[2];
        const rootFields = inner
          .split(/\n/)
          .map(l => l.trim())
          .filter(l => l && !l.startsWith("#"))
          .map(l => l.split(/[^A-Za-z0-9_]/)[0])
          .filter(Boolean);
        let validRoots: string[] = [];
        if (opType === "query") {
          validRoots = (await getTypeFields("query_root")).map(f => f.name);
        } else if (opType === "subscription") {
          validRoots = (await getTypeFields("subscription_root")).map(f => f.name);
        }
        const invalid = rootFields.filter(f => !validRoots.includes(f));
        if (invalid.length > 0) {
          return {
            content: [{ type: "text", text: `Query validation warning: Possible invalid root fields: ${invalid.join(", ")}.` }],
            isError: false
          };
        }
      }
      return { content: [{ type: "text", text: "Query validated successfully." }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Query syntax error: ${e.message}` }], isError: true };
    }
  } else if (toolName === "nl-query") {
    const description = args?.description as string;
    if (!description) {
      return { content: [{ type: "text", text: "Error: 'description' argument is required." }], isError: true };
    }

    const patterns = [
      {
        regex: /last call|recent call|conversation with (\w+)/i,
        template: "find-person",
        extractParams: (match: RegExpMatchArray) => ({ name: match[1] })
      },
      {
        regex: /issues|customer issues|top issues/i,
        template: "signal-by-type",
        extractParams: () => ({ type: "issue" })
      },
      {
        regex: /discussion|talk|conversation about (\w+)/i,
        template: "call-with-topic",
        extractParams: (match: RegExpMatchArray) => ({ topic: match[1] })
      }
    ];

    for (const pattern of patterns) {
      const match = description.match(pattern.regex);
      if (match) {
        const params = pattern.extractParams(match);
        if (!queryTemplates[pattern.template]) {
          return { content: [{ type: "text", text: `Internal error: NL pattern references unknown template '${pattern.template}'.` }], isError: true };
        }
        const templateQuery = queryTemplates[pattern.template](params);
        return {
          content: [
            { type: "text", text: "Based on your description, I've generated this query:" },
            { type: "text", text: templateQuery }
          ]
        };
      }
    }

    return {
      content: [{ type: "text", text: "I couldn't generate a specific query from your description. Try using terms like 'last call with [name]', 'customer issues', or 'discussions about [topic]'." }],
      isError: false
    };
  } else if (toolName === "open-resource" || toolName === "read-resource") {
    const uri = args?.uri as string;
    if (!uri) {
      return { content: [{ type: "text", text: "Error: 'uri' argument is required." }], isError: true };
    }
    // Simply return a content reference so the host can fetch it via MCP readResource
    return { content: [{ type: "resource", uri }] };
  } else if (toolName === "help") {
    const topic = (args?.topic as string | undefined)?.toLowerCase();
    if (!topic) {
      const helpText = `# BuildBetter MCP Help\n\n## Quick Start Tools\n- recent-conversation-with\n- top-customer-issues\n- topic-conversations\n- query-template\n- nl-query\n\nUse \`help(topic: \"queries\")\`, \`help(topic: \"schema\")\`, or \`help(topic: \"extractions\")\` for focused guidance.`;
      return { content: [{ type: "text", text: helpText }] };
    }
    const topics: Record<string, string> = {
      queries: `# Query Help\nUse \`query-template\` or \`nl-query\` to quickly build common queries.`,
      schema: `# Schema Help\nList types with \`list-types\`. Inspect a type with \`open-resource(uri: \"graphql://type/TypeName\")\`.`,
      extractions: `# Extractions Help\nSignals such as issues or feature requests live on the extraction table. Filter by type using joins.`
    };
    if (topics[topic]) {
      return { content: [{ type: "text", text: topics[topic] }] };
    }
    return { content: [{ type: "text", text: `No help available for topic '${topic}'.` }], isError: false };
  }

  // If tool name doesn't match, throw standard MCP error
  throw { code: -32601, message: "Method not found", data: { method: `tools/call/${toolName}` } };
});
// --- End Tool Handlers ---


// --- Prompt Handlers ---
const promptsList: Prompt[] = [
  {
    name: "recent-calls",
    description: "Generate a GraphQL query to list the most recent calls (interviews)",
    arguments: [
      { name: "limit", description: "Number of calls to return (default 10)", required: false }
    ]
  },
  {
    name: "call-details",
    description: "Retrieve detailed information about a specific call by ID",
    arguments: [
      { name: "id", description: "The interview/call ID", required: true }
    ]
  },
  {
    name: "call-transcript",
    description: "Retrieve the full transcript for a specific call by ID",
    arguments: [
      { name: "id", description: "The interview/call ID", required: true }
    ]
  },
  {
    name: "search-transcript",
    description: "Search within a call transcript for a specific phrase",
    arguments: [
      { name: "id", description: "The interview/call ID", required: true },
      { name: "phrase", description: "Text to search for (case-insensitive)", required: true }
    ]
  },
  {
    name: "call-extractions",
    description: "Retrieve extractions (signals) from a call, optionally filtered by type name",
    arguments: [
      { name: "id", description: "The interview/call ID", required: true },
      { name: "type", description: "Extraction type name (e.g. 'Product Feedback')", required: false }
    ]
  },
  {
    name: "signal-frequency",
    description: "Show how many extractions exist for each extraction type across all calls",
    arguments: []
  },
  {
    name: "feature-requests-by-date",
    description: "List feature-request extractions across calls in a date range",
    arguments: [
      { name: "startDate", description: "Start date (YYYY-MM-DD)", required: true },
      { name: "endDate", description: "End date (YYYY-MM-DD)", required: true }
    ]
  },
  {
    name: "explore-schema",
    description: "Guide the user on how to explore the GraphQL schema using available tools/resources",
    arguments: []
  },
  {
    name: "recent-issues",
    description: "Query the 20 most recent Issue-type extractions across all calls",
    arguments: []
  },
  {
    name: "feature-requests",
    description: "Query the 20 most recent Feature Request extractions",
    arguments: []
  },
  {
    name: "top-customer-issues",
    description: "Show the most recent Issue-type extractions with the related company name",
    arguments: [
      { name: "limit", description: "Number of rows to return (default 20)", required: false }
    ]
  },
  {
    name: "recent-objections",
    description: "List Objection-type extractions in a date range (defaults to last 30 days)",
    arguments: [
      { name: "startDate", description: "Start date (YYYY-MM-DD, optional – defaults to 30 days ago)", required: false },
      { name: "endDate", description: "End date (YYYY-MM-DD, optional – defaults to today)", required: false }
    ]
  },
  {
    name: "last-call-with-person",
    description: "Return the most recent call the specified person attended (searches by first name)",
    arguments: [
      { name: "name", description: "Person first name (case-insensitive)", required: true }
    ]
  },
  {
    name: "context-guide",
    description: "Open the BuildBetter GraphQL Context Guide resource",
    arguments: []
  },
  {
    name: "top-objections",
    description: "Alias for recent-objections (past N days, default 30)",
    arguments: [
      { name: "days", description: "Days back (default 30)", required: false }
    ]
  },
  {
    name: "customer-objections",
    description: "Objections voiced by customers within a time range (default 30 days)",
    arguments: [
      { name: "days", description: "Days back (default 30)", required: false },
      { name: "personaIds", description: "Array of persona IDs to include (default [246])", required: false }
    ]
  },
];

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: promptsList };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const sendUserMessage = (text: string) => ({ messages: [{ role: "user", content: { type: "text", text } }] });

  switch (name) {
    case "recent-calls": {
      const limit = args.limit ?? 10;
      const query = `query GetRecentCalls {\n  interview(order_by: {created_at: desc}, limit: ${limit}) {\n    id\n    name\n    created_at\n    recorded_at\n    completed_at\n    summary\n    short_summary\n    source\n    transcript_status\n    summary_state\n  }\n}`;
      return sendUserMessage(`Use the \`run-query\` tool with the following GraphQL to list the ${limit} most recent calls:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "call-details": {
      const id = args.id;
      if (!id) throw { code: -32602, message: "Missing required argument 'id'" };
      const query = `query GetCallDetails {\n  interview_by_pk(id: ${id}) {\n    id\n    name\n    created_at\n    recorded_at\n    completed_at\n    summary\n    short_summary\n    asset_duration_seconds\n    source\n    transcript_status\n    summary_state\n    attendees {\n      id\n      person_id\n      person {\n        id\n        first_name\n        last_name\n        email\n      }\n    }\n  }\n}`;
      return sendUserMessage(`Retrieve details for call **${id}** by running this query via \`run-query\`:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "call-transcript": {
      const id = args.id;
      if (!id) throw { code: -32602, message: "Missing required argument 'id'" };
      const query = `query GetCallTranscript {\n  interview_by_pk(id: ${id}) {\n    id\n    name\n    created_at\n    transcript_status\n    monologues(order_by: {start_sec: asc}) {\n      id\n      speaker\n      start_sec\n      end_sec\n      text\n    }\n  }\n}`;
      return sendUserMessage(`Fetch the full transcript for call **${id}** with:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "search-transcript": {
      const id = args.id;
      const phrase = args.phrase;
      if (!id || !phrase) throw { code: -32602, message: "Arguments 'id' and 'phrase' are required" };
      const query = `query SearchTranscriptContent {\n  interview_monologue(\n    where: {\n      text: {_ilike: \"%${phrase}%\"},\n      interview_id: {_eq: ${id}}\n    },\n    order_by: {start_sec: asc}\n  ) {\n    id\n    start_sec\n    end_sec\n    text\n    interview { id name }\n  }\n}`;
      return sendUserMessage(`Search for **${phrase}** in the transcript of call **${id}** using:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "call-extractions": {
      const id = args.id;
      if (!id) throw { code: -32602, message: "Missing required argument 'id'" };
      const typeName = args.type as string | undefined;
      const query = typeName ?
        `query GetExtractionsByType {\n  extraction(\n    where: {\n      types: { type: { name: {_eq: \"${typeName}\"} } },\n      interview_id: {_eq: ${id}}\n    }\n  ) {\n    id\n    text\n    start_sec\n    end_sec\n    interview { id name }\n    monologue { speaker text }\n  }\n}` :
        `query GetCallExtractions {\n  interview_by_pk(id: ${id}) {\n    id\n    name\n    extractions {\n      id\n      type_id\n      text\n      start_sec\n      end_sec\n      monologue { speaker text }\n    }\n  }\n}`;
      const desc = typeName ? `type **${typeName}**` : 'all types';
      return sendUserMessage(`Retrieve ${desc} extractions for call **${id}** with:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "signal-frequency": {
      const query = `query GetExtractionFrequency {\n  extraction_type {\n    id\n    name\n    extractions_aggregate { aggregate { count } }\n  }\n}`;
      return sendUserMessage(`Run this query to see extraction counts per type across all calls:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "feature-requests-by-date": {
      const startDate = args.startDate;
      const endDate = args.endDate;
      if (!startDate || !endDate) throw { code: -32602, message: "Arguments 'startDate' and 'endDate' are required" };
      const query = `query FeatureRequestsByDate {\n  extraction_type_join(\n    where: {\n      type: { _eq: featureRequest },\n      extraction: { interview: { created_at: { _gte: \"${startDate}T00:00:00\", _lte: \"${endDate}T23:59:59\" } } }\n    },\n    order_by: { extraction: { created_at: desc } }\n  ) {\n    extraction { id text created_at interview { id name created_at } }\n  }\n}`;
      return sendUserMessage(`Get feature-request extractions between **${startDate}** and **${endDate}** using:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "explore-schema": {
      const text = `Use the built-in resources and tools to explore the GraphQL schema.\n\n• List all types: call the \`list-types\` tool.\n• View a type\'s structure: read resource \`graphql://type/{TypeName}\`.\n• Build a basic query: call \`build-query\` with \`typeName\` and \`fields\` arguments.\n\nAsk follow-up questions to dig deeper into specific types or relationships.`;
      return sendUserMessage(text);
    }
    case "recent-issues": {
      const query = `query RecentIssues {\n  extraction_type_join(\n    where: { type: { _eq: issue } },\n    order_by: { extraction: { created_at: desc } },\n    limit: 20\n  ) {\n    extraction { id text created_at interview { id name created_at } }\n  }\n}`;
      return sendUserMessage(`Use \`run-query\` with:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "feature-requests": {
      const query = `query RecentFeatureRequests {\n  extraction_type_join(\n    where: { type: { _eq: featureRequest } },\n    order_by: { extraction: { created_at: desc } },\n    limit: 20\n  ) {\n    extraction { id text created_at interview { id name created_at } }\n  }\n}`;
      return sendUserMessage(`Use \`run-query\` with:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "top-customer-issues": {
      const limit = args.limit ?? 20;
      const query = `query TopCustomerIssues {\n  extraction_type_join(\n    where: { type: { _eq: issue } },\n    order_by: { extraction: { created_at: desc } },\n    limit: ${limit}\n  ) {\n    extraction { id summary created_at interview { id name company { id name } } }\n  }\n}`;
      return sendUserMessage(`Use \`run-query\` with:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "recent-objections": {
      const start = args.startDate ?? "<START_DATE>"; // defaults left as placeholders
      const end = args.endDate ?? "<END_DATE>";
      const query = `query RecentObjections {\n  extraction_type_join(\n    where: {\n      type: { _eq: objection },\n      extraction: { created_at: { _gte: \"${start}T00:00:00\", _lte: \"${end}T23:59:59\" } }\n    },\n    order_by: { extraction: { created_at: desc } }\n  ) {\n    extraction { id summary created_at interview { id name } }\n  }\n}`;
      return sendUserMessage(`Run this query (replace the placeholder dates if needed):\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "last-call-with-person": {
      const nameArg = args.name;
      if (!nameArg) throw { code: -32602, message: "Missing required argument 'name'" };
      const query = `query LastCallWithPerson {\n  person(where: { first_name: { _ilike: \"${nameArg}\" } }, limit: 1) {\n    first_name\n    last_name\n    interview_attendees(order_by: { interview: { recorded_at: desc } }, limit: 1) {\n      interview { id name recorded_at }\n    }\n  }\n}`;
      return sendUserMessage(`Use \`run-query\` with:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "context-guide": {
      const text = `Open the guide with the \`open-resource\` tool:\n\n{ \"name\": \"open-resource\", \"arguments\": { \"uri\": \"graphql://guide/context\" } }\n`;
      return sendUserMessage(text);
    }
    case "top-objections": {
      const days = args.days ?? 30;
      const millisBack = Number(days) * 24 * 60 * 60 * 1000;
      const startDate = new Date(Date.now() - millisBack).toISOString().slice(0,10);
      return await (server as any).request({ // forward to existing prompt
        method: "prompts/get",
        params: { name: "recent-objections", arguments: { startDate, endDate: new Date().toISOString().slice(0,10) } }
      });
    }
    case "customer-objections": {
      const days = args.days ?? 30;
      const personaArr: number[] = Array.isArray(args.personaIds) ? (args.personaIds as number[]) : [246];
      const millis = Number(days)*24*60*60*1000;
      const start = new Date(Date.now()-millis).toISOString().slice(0,10);
      const end = new Date().toISOString().slice(0,10);
      const query = `query CustomerObjections {\n  extraction_type_join(\n    where: {\n      type: {_eq: objection},\n      extraction: {\n        created_at: {_gte: \"${start}\"},\n        speaker: { person: { persona_id: {_in: [${personaArr.join(',')}] } } }\n      }\n    },\n    order_by: { extraction: { created_at: desc } },\n    limit: 20\n  ) {\n    extraction { id summary created_at sentiment }\n  }\n}`;
      return sendUserMessage(`Use the run-query tool with this GraphQL:\n\n${query}`);
    }
    default:
      throw { code: -32601, message: "Prompt not found", data: { name } };
  }
});
// --- End Prompt Handlers ---


// --- Main Execution ---
async function main() {
  const transport = new StdioServerTransport();
  // @ts-ignore – SDK types may not include the second parameter yet
  await server.connect(transport, {
    initializationOptions: {
      requiredResources: ["graphql://guide/context"]
    }
  });
  // Send onboarding notification so the assistant sees the guide early
  try {
    await server.notification({
      method: "chat/message",
      params: {
        role: "system",
        content: { type: "text", text: "Before querying, open the BuildBetter context guide via the `read-resource` tool (uri: graphql://guide/context)." }
      }
    });
  } catch {
    /* ignore if transport doesn't support notifications */
  }
  console.error("GraphQL MCP Server started successfully via stdio");
}

main().catch(error => {
  console.error("Error starting server:", error instanceof Error ? error.message : error);
  // Use standard MCP error codes if possible
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : -32000;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Exiting with code ${code}: ${message}`);
  process.exit(1); // Ensure process exits on error
});