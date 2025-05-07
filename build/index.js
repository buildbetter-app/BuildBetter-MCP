// Imports based on the provided postgres example
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
// Add other necessary types from sdk/types.js
 } from "@modelcontextprotocol/sdk/types.js";
// Zod is not used in this low-level handler approach, removed import
import { GraphQLClient, gql, } from 'graphql-request';
import dotenv from 'dotenv';
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
const server = new Server({
    name: "BuildBetter's Data Explorer",
    version: "0.0.1",
}, {
    capabilities: {
        resources: { listChanged: true }, // Assuming listChanged is supported
        tools: { listChanged: true }, // Assuming listChanged is supported
        prompts: { listChanged: true }, // Assuming listChanged is supported
    },
});
// Simple in-memory cache for schema introspection
let cachedSchema = null;
const SCHEMA_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
// --- Helper Functions (Keep as they are) ---
async function getSchemaInfo() {
    // Return cached schema if still fresh
    if (cachedSchema && Date.now() - cachedSchema.fetchedAt < SCHEMA_CACHE_TTL_MS) {
        return cachedSchema.data;
    }
    const query = gql `
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
        const data = await graphqlClient.request(query);
        cachedSchema = { data, fetchedAt: Date.now() };
        return data;
    }
    catch (error) {
        console.error('Error fetching schema:', error instanceof Error ? error.message : error);
        throw error;
    }
}
function filterObjectTypes(schema) {
    if (!schema || !schema.__schema || !schema.__schema.types) {
        return [];
    }
    return schema.__schema.types.filter((type) => {
        return !!type && type.kind === 'OBJECT' && !!type.name && !type.name.startsWith('__');
    });
}
function formatTypeForDisplay(type) {
    if (!type)
        return 'Unknown';
    if (type.kind === 'NON_NULL')
        return `${formatTypeForDisplay(type.ofType)}!`;
    if (type.kind === 'LIST')
        return `[${formatTypeForDisplay(type.ofType)}]`;
    return type.name || 'UnnamedType';
}
// Helper to fetch field names for given type via introspection
async function getTypeFields(typeName) {
    const query = gql `
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
    const data = await graphqlClient.request(query, { name: typeName });
    const t = data.__type;
    if (!t)
        return [];
    const fieldsWithType = [];
    if (t.fields) {
        fieldsWithType.push(...t.fields.map((f) => ({ name: f.name, type: f.type })));
    }
    if (t.inputFields) {
        fieldsWithType.push(...t.inputFields.map((f) => ({ name: f.name, type: f.type })));
    }
    return fieldsWithType;
}
// --- End Helper Functions ---
// --- Resource Handlers ---
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    // For now, let's list the two main resources we defined conceptually
    const resources = [
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
                const content = objectTypes.map((type) => `# ${type.name}\n${type.description ? type.description + '\n' : ''}`).join('\n\n');
                return { contents: [{ uri: uri, mimeType: "text/markdown", text: content }] };
            }
            catch (error) {
                // Return a valid ReadResourceResult structure even on error
                return { contents: [{ uri: uri, text: `Error fetching schema: ${error instanceof Error ? error.message : String(error)}` }] };
            }
        }
        else if (parsedUri.pathname.startsWith("//type/")) {
            // Handle reading a specific type resource
            const typeName = parsedUri.pathname.substring("//type/".length);
            if (!typeName) {
                // Return a valid ReadResourceResult structure
                return { contents: [{ uri: uri, text: "Error: Type name missing in URI." }] };
            }
            try {
                const schema = await getSchemaInfo();
                const objectTypes = filterObjectTypes(schema);
                const selectedType = objectTypes.find((type) => type.name === typeName);
                if (!selectedType) {
                    // Return a valid ReadResourceResult structure
                    return { contents: [{ uri: uri, text: `Type "${typeName}" not found in schema.` }] };
                }
                let content = `# ${selectedType.name}\n\n${selectedType.description ? selectedType.description + '\n\n' : ''}## Fields\n\n`;
                if (selectedType.fields && selectedType.fields.length > 0) {
                    selectedType.fields.forEach((field) => {
                        content += `### ${field.name}\n**Type:** ${formatTypeForDisplay(field.type)}\n${field.description ? `**Description:** ${field.description}\n` : ''}\n`;
                    });
                }
                else {
                    content += "No fields available.\n";
                }
                return { contents: [{ uri: uri, mimeType: "text/markdown", text: content }] };
            }
            catch (error) {
                // Return a valid ReadResourceResult structure
                return { contents: [{ uri: uri, text: `Error fetching type ${typeName}: ${error instanceof Error ? error.message : String(error)}` }] };
            }
        }
        else if (parsedUri.pathname === "//guide/context") {
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
        }
        else if (parsedUri.pathname === "//docs/schema-relationships") {
            const md = `# BuildBetter Schema Relationships\n\n\`\`\`mermaid\nflowchart TB\n  interview -->|has many| interview_monologue\n  interview -->|has many| extraction\n  interview -->|has many| interview_attendee\n  extraction -->|many-to-many| extraction_type\n  extraction -->|many-to-many| extraction_topic\n  extraction -->|many-to-many| extraction_emotion\n  interview_attendee --> person\n  person --> company\n\`\`\`\n\nKey points:\n- **extraction_type_joins** links extractions ↔ extraction_type.\n- Filter extractions by type with:\n  \`extraction_type_joins: { extraction_type: { name: {_eq: \"Product Feedback\"} } }\`\n- Each extraction belongs to one interview and optionally one monologue segment.\n`;
            return { contents: [{ uri, mimeType: "text/markdown", text: md }] };
        }
        else if (parsedUri.pathname === "//examples/common-queries") {
            const md = `# Common BuildBetter Queries\n\n## Recent Issues\n\n\`\`\`graphql\nquery RecentIssues {\n  extraction(\n    where: {\n      extraction_type_joins: { extraction_type: { name: {_eq: \"Issue\"} } }\n    },\n    order_by: { created_at: desc },\n    limit: 20\n  ) {\n    id\n    text\n    created_at\n    interview { id name created_at }\n  }\n}\n\`\`\`\n\n## Feature Requests (last 30 days)\n\n\`\`\`graphql\nquery RecentFeatureRequests {\n  extraction(\n    where: {\n      extraction_type_joins: { extraction_type: { name: {_eq: \"Feature Request\"} } },\n      created_at: { _gte: \"2025-05-01\" }\n    }\n  ) { id text interview { name } }\n}\n\`\`\`\n\n## Filter Extractions by Keyword\n\n\`\`\`graphql\nquery SearchExtractions($keyword: String!) {\n  extraction(where: { text: {_ilike: $keyword} }) { id text interview { name } }\n}\n\`\`\`\n`;
            return { contents: [{ uri, mimeType: "text/markdown", text: md }] };
        }
        else if (parsedUri.pathname === "//guide/practical-examples") {
            const practicalExamplesMd = `# Practical Query Examples for BuildBetter

This guide provides ready-to-use examples for common scenarios.
Replace placeholders like \`"PERSON_NAME"\`, \`"TOPIC_KEYWORD"\`, or date strings with actual values.

## 1. Finding Recent Calls/Interviews with a Specific Person

This uses a conceptual approach. The actual fields (\`person.name\`, \`interview.attendees\`, date fields) depend on your schema.

\`\`\`graphql
# Placeholder - Requires schema knowledge for exact fields
query RecentCallsWithPerson($personName: String = "John Doe", $limit: Int = 5) {
  interviews(
    order_by: { created_at: desc }
    where: {
      attendees: { person: { name: { _ilike: $personName } } }
      # or, if person is directly on interview:
      # person: { name: { _ilike: $personName } }
    }
    limit: $limit
  ) {
    id
    name
    created_at
    # Potentially attendees { person { name } }
  }
}
\`\`\`

## 2. Analyzing Customer Issues Over Time (e.g., last 30 days)

This assumes 'Issue' is an extraction_type and extractions have a \`created_at\` field.

\`\`\`graphql
# Placeholder - Requires schema knowledge
query CustomerIssuesLast30Days($limit: Int = 20, $sinceDate: timestamptz = "YYYY-MM-DD") {
  extraction(
    where: {
      extraction_type_joins: { extraction_type: { name: { _eq: "Issue" } } }
      # Assuming 'Customer' is a persona or can be filtered via speaker
      # speaker: { person: { persona_id: { _eq: CUSTOMER_PERSONA_ID } } }
      created_at: { _gte: $sinceDate }
    }
    order_by: { created_at: desc }
    limit: $limit
  ) {
    id
    text # or summary
    created_at
    interview { id name }
  }
}
\`\`\`

## 3. Tracking Discussions on Specific Topics

This uses the \`search-extractions\` tool's underlying logic but as a direct query.

\`\`\`graphql
# Placeholder - Requires schema knowledge
query TopicExtractions($topic: String = "integration", $limit: Int = 10) {
  extraction(
    where: {
      _or: [
        { text: { _ilike: $topic } },
        { summary: { _ilike: $topic } }
        # Add other relevant text fields
      ]
    }
    order_by: { created_at: desc }
    limit: $limit
  ) {
    id
    text # or summary
    created_at
    interview { id name }
  }
}
\`\`\`

## 4. Monitoring Feature Requests and Complaints

Similar to customer issues, but filtering by different extraction types.

\`\`\`graphql
# Placeholder - Requires schema knowledge
query FeatureRequestsAndComplaints($limit: Int = 10, $sinceDate: timestamptz = "YYYY-MM-DD") {
  extraction(
    where: {
      extraction_type_joins: {
        extraction_type: {
          name: { _in: ["Feature Request", "Complaint", "Bug Report"] }
        }
      }
      created_at: { _gte: $sinceDate }
    }
    order_by: { created_at: desc }
    limit: $limit
  ) {
    id
    text
    created_at
    extraction_type_joins { extraction_type { name } }
    interview { id name }
  }
}
\`\`\`

**Note:** These queries are illustrative. You'll need to adapt field names (\`attendees\`, \`person\`, \`extraction_type_joins\`, \`text\`, \`summary\`, \`created_at\`, etc.) and type names to match your specific BuildBetter GraphQL schema. Use the \`list-types\` and \`find-fields\` tools to discover the correct names.
`;
            return { contents: [{ uri, mimeType: "text/markdown", text: practicalExamplesMd }] };
        }
    }
    // If URI doesn't match known patterns, throw a standard MCP error
    throw { code: -32002, message: "Resource not found", data: { uri } };
});
// --- End Resource Handlers ---
// --- Tool Handlers ---
const toolsList = [
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
    }
];
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: toolsList };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};
    if (toolName === "run-query") {
        const query = args?.query;
        const variables = args?.variables;
        if (!query) {
            return { content: [{ type: "text", text: "Error: 'query' argument is required." }], isError: true };
        }
        const queryText = query.trim().toLowerCase();
        if (queryText.startsWith('mutation') || queryText.includes('mutation {')) {
            return { content: [{ type: "text", text: "Error: Only read-only queries are allowed." }], isError: true };
        }
        try {
            const result = await graphqlClient.request(query, variables);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            // Look for common errors and provide helpful suggestions
            if (errorMsg.includes("field not found") || errorMsg.includes("Cannot query field")) { // Added common alternative phrasing
                // Try to extract the field name from error
                const fieldMatch = errorMsg.match(/field '([^']+)' not found/) || errorMsg.match(/Cannot query field "([^"]+)" on type/);
                const fieldName = fieldMatch && fieldMatch[1] ? fieldMatch[1] : "unknown";
                // Placeholder for suggestSimilarFields
                const similarFieldsSuggestion = "[similar field suggestions pending implementation]";
                return {
                    content: [{
                            type: "text",
                            text: `Error: Field '${fieldName}' not found or not queryable on the specified type. Try using the 'find-fields' tool first to check available fields for the relevant type, or consider these similar fields: ${similarFieldsSuggestion}. Original error: ${errorMsg}`
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
    }
    else if (toolName === "list-types") {
        try {
            const schema = await getSchemaInfo();
            const objectTypes = filterObjectTypes(schema);
            const typeNames = objectTypes.map((type) => type.name);
            return { content: [{ type: "text", text: JSON.stringify(typeNames, null, 2) }] };
        }
        catch (error) {
            return { content: [{ type: "text", text: `Error fetching types: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
    }
    else if (toolName === "build-query") {
        const typeName = args?.typeName;
        const fields = args?.fields;
        const limit = args?.limit;
        const filter = args?.filter;
        if (!typeName || !fields || fields.length === 0) {
            return { content: [{ type: "text", text: "Error: 'typeName' and 'fields' arguments are required." }], isError: true };
        }
        try {
            const schema = await getSchemaInfo();
            const objectTypes = filterObjectTypes(schema);
            const selectedType = objectTypes.find((type) => type.name === typeName);
            if (!selectedType) {
                return { content: [{ type: "text", text: `Error: Type "${typeName}" not found.` }], isError: true };
            }
            const validFields = selectedType.fields?.map((f) => f.name) ?? [];
            const invalidFields = fields.filter(f => !validFields.includes(f));
            if (invalidFields.length > 0) {
                return { content: [{ type: "text", text: `Error: Invalid fields for "${typeName}": ${invalidFields.join(', ')}` }], isError: true };
            }
            let queryParams = '';
            const params = [];
            if (limit !== undefined && Number.isInteger(limit) && limit > 0)
                params.push(`first: ${limit}`);
            if (filter && Object.keys(filter).length > 0) {
                const filterStr = Object.entries(filter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
                if (filterStr)
                    params.push(`where: {${filterStr}}`);
            }
            if (params.length > 0)
                queryParams = `(${params.join(', ')})`;
            const queryName = selectedType.name.charAt(0).toLowerCase() + selectedType.name.slice(1) + 's';
            const queryString = `query Get${selectedType.name} { ${queryName}${queryParams} { ${fields.join('\n    ')} } }`;
            return { content: [{ type: "text", text: queryString.trim() }] };
        }
        catch (error) {
            return { content: [{ type: "text", text: `Error building query: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
    }
    else if (toolName === "schema-overview") {
        // Simply return the markdown from the static resource so the client can render it
        const mdUri = "graphql://docs/schema-relationships";
        return { content: [{ type: "resource", uri: mdUri }] };
    }
    else if (toolName === "search-extractions") {
        const phrase = args?.phrase;
        const extType = args?.type;
        const limit = args?.limit;
        const personaIds = args?.personaIds;
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
            const orConditions = smartSearchableFields.map(field => `{ ${field}: {_ilike: "%${phrase}%"} }` // Each condition is an object
            ).join(", ");
            whereTextCondition = smartSearchableFields.length > 1
                ? `_or: [${orConditions}]`
                : orConditions.slice(2, -2); // Remove surrounding { } if only one field
        }
        else if (textField) { // Fallback to the single textField if smart fields aren't found (should not happen if textField logic is sound)
            whereTextCondition = `${textField}: {_ilike: "%${phrase}%"}`;
        }
        else {
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
        const selectionFields = ["id", textField, "created_at"];
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
        }
        catch (error) {
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
    }
    else if (toolName === "recent-conversation-with") {
        const name = args?.name;
        const limit = args?.limit; // Default: 1
        if (!name) {
            return { content: [{ type: "text", text: "Error: 'name' argument is required." }], isError: true };
        }
        // Placeholder implementation
        return { content: [{ type: "text", text: `Tool 'recent-conversation-with' called with name: ${name}, limit: ${limit ?? 1}. Implementation pending.` }] };
    }
    else if (toolName === "top-customer-issues") {
        const limit = args?.limit; // Default: 10
        const days = args?.days; // Default: 30
        // Placeholder implementation
        return { content: [{ type: "text", text: `Tool 'top-customer-issues' called with limit: ${limit ?? 10}, days: ${days ?? 30}. Implementation pending.` }] };
    }
    else if (toolName === "topic-conversations") {
        const topic = args?.topic;
        const limit = args?.limit; // Default: 5
        if (!topic) {
            return { content: [{ type: "text", text: "Error: 'topic' argument is required." }], isError: true };
        }
        // Placeholder implementation
        return { content: [{ type: "text", text: `Tool 'topic-conversations' called with topic: ${topic}, limit: ${limit ?? 5}. Implementation pending.` }] };
    }
    else if (toolName === "query-template") {
        const template = args?.template;
        const parameters = args?.parameters;
        if (!template) {
            return { content: [{ type: "text", text: "Error: 'template' argument is required." }], isError: true };
        }
        // Placeholder implementation
        // Actual implementation would involve a switch/map for template names
        // and constructing GraphQL queries based on templates and parameters.
        return { content: [{ type: "text", text: `Tool 'query-template' called with template: ${template}, parameters: ${JSON.stringify(parameters)}. Implementation pending.` }] };
    }
    else if (toolName === "find-fields") {
        const typeName = args?.typeName;
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
        }
        catch (error) {
            return { content: [{ type: "text", text: `Error introspecting type: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
    }
    else if (toolName === "validate-query") {
        const query = args?.query;
        if (!query) {
            return { content: [{ type: "text", text: "Error: 'query' argument is required." }], isError: true };
        }
        // Placeholder implementation
        // Actual implementation might involve using a GraphQL parsing library
        // or a dry-run validation endpoint if available.
        try {
            // Attempt to parse with gql as a very basic syntax check
            gql `${query}`;
            return { content: [{ type: "text", text: "Query syntax appears valid (basic check). Full validation pending implementation." }] };
        }
        catch (e) {
            return { content: [{ type: "text", text: `Query syntax error: ${e.message}` }], isError: true };
        }
    }
    else if (toolName === "open-resource" || toolName === "read-resource") {
        const uri = args?.uri;
        if (!uri) {
            return { content: [{ type: "text", text: "Error: 'uri' argument is required." }], isError: true };
        }
        // Simply return a content reference so the host can fetch it via MCP readResource
        return { content: [{ type: "resource", uri }] };
    }
    // If tool name doesn't match, throw standard MCP error
    throw { code: -32601, message: "Method not found", data: { method: `tools/call/${toolName}` } };
});
// --- End Tool Handlers ---
// --- Prompt Handlers ---
const promptsList = [
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
    const sendUserMessage = (text) => ({ messages: [{ role: "user", content: { type: "text", text } }] });
    switch (name) {
        case "recent-calls": {
            const limit = args.limit ?? 10;
            const query = `query GetRecentCalls {\n  interview(order_by: {created_at: desc}, limit: ${limit}) {\n    id\n    name\n    created_at\n    recorded_at\n    completed_at\n    summary\n    short_summary\n    source\n    transcript_status\n    summary_state\n  }\n}`;
            return sendUserMessage(`Use the \`run-query\` tool with the following GraphQL to list the ${limit} most recent calls:\n\n\`\`\`graphql\n${query}\n\`\`\``);
        }
        case "call-details": {
            const id = args.id;
            if (!id)
                throw { code: -32602, message: "Missing required argument 'id'" };
            const query = `query GetCallDetails {\n  interview_by_pk(id: ${id}) {\n    id\n    name\n    created_at\n    recorded_at\n    completed_at\n    summary\n    short_summary\n    asset_duration_seconds\n    source\n    transcript_status\n    summary_state\n    attendees {\n      id\n      person_id\n      person {\n        id\n        first_name\n        last_name\n        email\n      }\n    }\n  }\n}`;
            return sendUserMessage(`Retrieve details for call **${id}** by running this query via \`run-query\`:\n\n\`\`\`graphql\n${query}\n\`\`\``);
        }
        case "call-transcript": {
            const id = args.id;
            if (!id)
                throw { code: -32602, message: "Missing required argument 'id'" };
            const query = `query GetCallTranscript {\n  interview_by_pk(id: ${id}) {\n    id\n    name\n    created_at\n    transcript_status\n    monologues(order_by: {start_sec: asc}) {\n      id\n      speaker\n      start_sec\n      end_sec\n      text\n    }\n  }\n}`;
            return sendUserMessage(`Fetch the full transcript for call **${id}** with:\n\n\`\`\`graphql\n${query}\n\`\`\``);
        }
        case "search-transcript": {
            const id = args.id;
            const phrase = args.phrase;
            if (!id || !phrase)
                throw { code: -32602, message: "Arguments 'id' and 'phrase' are required" };
            const query = `query SearchTranscriptContent {\n  interview_monologue(\n    where: {\n      text: {_ilike: \"%${phrase}%\"},\n      interview_id: {_eq: ${id}}\n    },\n    order_by: {start_sec: asc}\n  ) {\n    id\n    start_sec\n    end_sec\n    text\n    interview { id name }\n  }\n}`;
            return sendUserMessage(`Search for **${phrase}** in the transcript of call **${id}** using:\n\n\`\`\`graphql\n${query}\n\`\`\``);
        }
        case "call-extractions": {
            const id = args.id;
            if (!id)
                throw { code: -32602, message: "Missing required argument 'id'" };
            const typeName = args.type;
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
            if (!startDate || !endDate)
                throw { code: -32602, message: "Arguments 'startDate' and 'endDate' are required" };
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
            if (!nameArg)
                throw { code: -32602, message: "Missing required argument 'name'" };
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
            const startDate = new Date(Date.now() - millisBack).toISOString().slice(0, 10);
            return await server.request({
                method: "prompts/get",
                params: { name: "recent-objections", arguments: { startDate, endDate: new Date().toISOString().slice(0, 10) } }
            });
        }
        case "customer-objections": {
            const days = args.days ?? 30;
            const personaArr = Array.isArray(args.personaIds) ? args.personaIds : [246];
            const millis = Number(days) * 24 * 60 * 60 * 1000;
            const start = new Date(Date.now() - millis).toISOString().slice(0, 10);
            const end = new Date().toISOString().slice(0, 10);
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
    }
    catch {
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
