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
const BUILDBETTER_ENDPOINT = process.env.BUILDBETTER_ENDPOINT || 'https://api.buildbetter.app/v1/graphql';
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
    version: "0.0.2", // Incremented version
  },
  {
    capabilities: {
      resources: { listChanged: true }, 
      tools: { listChanged: true },     
      prompts: { listChanged: true },   
    },
  },
);

// Simple in-memory cache for schema introspection
let cachedSchema: { data: IntrospectionResult; fetchedAt: number } | null = null;
const SCHEMA_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// --- Helper Functions ---
async function getSchemaInfo(): Promise<IntrospectionResult> {
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
          enumValues { name description } # Added for enum introspection
        }
      }
    }
    fragment TypeRef on __Type {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name ofType { kind name } } 
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

async function getTypeFields(typeName: string): Promise<{ name: string; type: GraphQLOutputType; description?: string | null }[]> {
  const query = gql`
    query GetTypeFields($name: String!) {
      __type(name: $name) {
        ... on __Type {
          name
          kind
          description # Added type description
          fields(includeDeprecated: false) { # Ensure deprecated are false
            name
            description
            type { ...TypeRef }
          }
          inputFields {
            name
            description
            type { ...TypeRef }
          }
          enumValues { name description } # Added for enums
        }
      }
    }
    fragment TypeRef on __Type {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name ofType { kind name ofType { kind name } } } 
      }
    }
  `;
  const data = await graphqlClient.request<{ __type: any }>(query, { name: typeName });
  const t = data.__type;
  if (!t) return [];
  const fieldsWithType: { name: string; type: GraphQLOutputType; description?: string | null }[] = [];
  if (t.fields) {
    fieldsWithType.push(...t.fields.map((f: any) => ({ name: f.name, type: f.type as GraphQLOutputType, description: f.description })));
  }
  if (t.inputFields) { // For Input Object types
    fieldsWithType.push(...t.inputFields.map((f: any) => ({ name: f.name, type: f.type as GraphQLOutputType, description: f.description })));
  }
  if (t.enumValues) { // For Enum types
     fieldsWithType.push(...t.enumValues.map((ev: any) => ({ name: ev.name, type: { kind: "ENUM_VALUE", name: ev.name } as GraphQLOutputType, description: ev.description })));
  }
  return fieldsWithType;
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }
  return matrix[b.length][a.length];
}

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
    return similar.slice(0, 3); // Return top 3
  } catch (err) {
    // console.error(`Error finding similar fields for ${typeName}.${fieldName}:`, err); // Keep console log for server-side debug
    return [];
  }
}

// Improvement 2: Enum helper
function normalizeEnumValue(value: string | number | undefined): string {
  if (value === undefined || value === null) return ""; // Or handle as error
  return String(value).replace(/^["']|["']$/g, ''); // Remove surrounding quotes
}
// --- End Helper Functions ---

// Shared query templates used by both `query-template` and `nl-query` tools
// Improvement 4: Dedicated templates

interface QueryTemplateParameter {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  default?: any;
  example?: any;
}
interface QueryTemplate {
  description: string;
  parameters: QueryTemplateParameter[];
  generateQuery: (params: any) => string;
  getExampleVariables?: (params: any) => Record<string, any>;
}

const queryTemplates: Record<string, QueryTemplate> = {
  "find-person": {
    description: "Find a person by their first or last name. Returns basic info and company.",
    parameters: [
      { name: "name", type: "string", description: "First or last name to search for.", required: true, example: "Alice" },
      { name: "limit", type: "number", description: "Maximum number of person records to return.", default: 5, required: false }
    ],
    generateQuery: (params) => {
      const name = params?.name ? String(params.name).replace(/[%_]/g, '') : "";
      const nameParam = `%${name}%`; // Stays for variable usage
      const limit = Math.min(Math.max(1, parseInt(String(params?.limit ?? 5), 10)), 25);
      return gql`
        query FindPerson($nameParam: String!, $limit: Int!) {
          person(
            where: {_or: [{first_name: {_ilike: $nameParam}}, {last_name: {_ilike: $nameParam}}]},
            limit: $limit
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
    getExampleVariables: (params) => {
      const name = params?.name ? String(params.name).replace(/[%_]/g, '') : "Alice";
      return {
        nameParam: `%${name}%`,
        limit: Math.min(Math.max(1, parseInt(String(params?.limit ?? 5), 10)), 25)
      };
    }
  },
  "last-call-with-person": {
    description: "Find the last call (interview) a specific person attended, identified by name. Returns person details and their last interview details including attendees.",
    parameters: [
      { name: "name", type: "string", description: "First or last name of the person.", required: true, example: "Bob" },
      { name: "interviewLimit", type: "number", description: "Max number of interviews to return per matching person (useful if name is ambiguous).", default: 1, required: false }
    ],
    generateQuery: (params) => {
      const personSearchLimit = 5; // How many people to check if name is ambiguous
      const interviewLimit = Math.min(Math.max(1, parseInt(String(params?.interviewLimit ?? 1), 10)), 10);

      return gql`
        query LastCallWithPersonByName($nameParam: String!, $personSearchLimit: Int!, $interviewLimit: Int!) {
          person( 
            where: {_or: [{first_name: {_ilike: $nameParam}}, {last_name: {_ilike: $nameParam}}]},
            limit: $personSearchLimit 
          ) {
            id
            first_name
            last_name
            email
            title
            company { name }
            interview_attendees(
              order_by: {interview: {display_ts: desc}},
              limit: $interviewLimit 
            ) {
              interview {
                id
                name
                display_ts
                recorded_at
                short_summary
                attendees(limit: 5) {
                  person { id first_name last_name email }
                }
              }
            }
          }
        }
      `;
    },
    getExampleVariables: (params) => {
      const name = params?.name ? String(params.name).replace(/[%_]/g, '') : "Bob";
      return {
        nameParam: `%${name}%`,
        personSearchLimit: 5, // Internal logic for how many people to search if name is ambiguous
        interviewLimit: Math.min(Math.max(1, parseInt(String(params?.interviewLimit ?? 1), 10)), 10)
      };
    }
  },
  "recent-calls-with-person": {
    description: "Find recent calls involving a specific person by searching interview attendees. Returns interview details.",
    parameters: [
      { name: "name", type: "string", description: "Person name (first or last) to search within attendees.", required: true, example: "Nikhil" },
      { name: "limit", type: "number", default: 5, description: "Maximum number of calls to return.", required: false }
    ],
    generateQuery: (params) => {
      const name = params?.name ? String(params.name).replace(/[%_]/g, '') : "";
      const limit = Math.min(Math.max(1, parseInt(String(params?.limit ?? 5), 10)), 25);
      return gql`
        query RecentCallsWithPerson($nameParam: String!, $limit: Int!) {
          interview_attendee(
            where: {
              person: {
                _or: [
                  {first_name: {_ilike: $nameParam}},
                  {last_name: {_ilike: $nameParam}}
                ]
              }
            },
            order_by: {interview: {display_ts: desc}},
            limit: $limit
          ) {
            interview {
              id
              name
              display_ts
              recorded_at
              short_summary
              attendees(limit: 3) {
                person { first_name, last_name }
              }
            }
          }
        }
      `;
    },
    getExampleVariables: (params) => {
      const name = params?.name ? String(params.name).replace(/[%_]/g, '') : "Nikhil";
      return {
        nameParam: `%${name}%`,
        limit: Math.min(Math.max(1, parseInt(String(params?.limit ?? 5), 10)), 25)
      };
    }
  },
  "recent-calls": {
    description: "List the most recent calls (interviews).",
    parameters: [
      { name: "limit", type: "number", description: "Number of calls to return.", default: 10, required: false }
    ],
    generateQuery: (params) => {
      const limit = Math.min(Math.max(1, parseInt(String(params?.limit ?? 10), 10)), 50);
      return gql`
        query RecentCalls($limit: Int!) {
          interview(
            order_by: {display_ts: desc},
            limit: $limit
          ) {
            id
            name
            display_ts
            recorded_at
            short_summary
            attendees(limit: 3) { person { first_name last_name } }
          }
        }
      `;
    },
    getExampleVariables: (params) => {
      return {
        limit: Math.min(Math.max(1, parseInt(String(params?.limit ?? 10), 10)), 50)
      };
    }
  },
  "call-with-topic": {
    description: "Find calls (interviews) discussing a specific topic by searching extraction summaries.",
    parameters: [
      { name: "topic", type: "string", description: "Topic/keyword to search for in extraction summaries.", required: true, example: "integration" },
      { name: "limit", type: "number", description: "Maximum number of extractions (and thus indirectly calls) to return.", default: 5, required: false }
    ],
    generateQuery: (params) => {
      const topic = params?.topic ? String(params.topic).replace(/[%_]/g, '') : "";
      const topicParam = `%${topic}%`;
      const limit = Math.min(Math.max(1, parseInt(String(params?.limit ?? 5), 10)), 25);
      return gql`
        query CallsWithTopic($topicParam: String!, $limit: Int!) {
          extraction(
            where: { summary: {_ilike: $topicParam} },
            order_by: {display_ts: desc},
            limit: $limit
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
    getExampleVariables: (params) => {
      const topic = params?.topic ? String(params.topic).replace(/[%_]/g, '') : "integration";
      return {
        topicParam: `%${topic}%`,
        limit: Math.min(Math.max(1, parseInt(String(params?.limit ?? 5), 10)), 25)
      };
    }
  },
   "signal-by-type": {
    description: "Retrieve recent extractions (signals) of a specific type. Can optionally filter by time window (days) and speaker's persona ID.",
    parameters: [
      { name: "type", type: "string", description: "The extraction type name (enum value, e.g., 'issue', 'featureRequest').", required: true, example: "issue" }, // Made 'type' required, removed default
      { name: "limit", type: "number", description: "Number of signals to return.", default: 10, required: false },
      { name: "days", type: "number", description: "Optional: Time window in days. If provided, filters signals newer than this many days ago.", required: false, example: 30 },
      { name: "personaId", type: "number", description: "Optional: Filter by speaker's persona ID (e.g., 246 for Customer).", required: false, example: 246 }
    ],
    generateQuery: (params) => {
      const type = normalizeEnumValue(params?.type);
      if (!type) {
        // This case should ideally be caught by 'required: true' on the parameter, 
        // but as a fallback, or if used programmatically without validation:
        throw new Error("The 'type' parameter is required for the signal-by-type template.");
      }

      const gqlVariables: string[] = [];
      const whereClauses: string[] = [`types: { type: { name: {_eq: ${type}} } }`]; // Type is directly interpolated

      if (params?.days !== undefined) {
        gqlVariables.push("$sinceDateParam: timestamp!");
        whereClauses.push(`display_ts: {_gte: $sinceDateParam}`);
      }
      if (params?.personaId !== undefined) {
        gqlVariables.push("$personaIdParam: Int!");
        whereClauses.push(`attendee: { person: { persona_id: {_eq: $personaIdParam} } }`);
      }

      const variableDefinitionString = gqlVariables.length > 0 ? `(${gqlVariables.join(', ')})` : "";
      const whereClauseString = whereClauses.join(', ');
      
      // Limit is directly interpolated as it's a simple integer with guardrails.
      const limit = Math.min(Math.max(1, parseInt(String(params?.limit ?? 10), 10)), 50);

      return gql`
        query SignalsByType${variableDefinitionString} {
          extraction(
            where: { _and: [ {${whereClauseString}} ] },
            order_by: {display_ts: desc},
            limit: ${limit}
          ) {
            id
            summary
            display_ts
            sentiment
            call { id name company { name } }
            attendee { person { first_name last_name persona_id company { name } } }
            types { type { name } }
          }
        }
      `;
    },
    getExampleVariables: (params) => {
      const exampleVars: Record<string, any> = {};
      if (params?.days !== undefined) {
        let daysNum = parseInt(String(params.days), 10);
        if (!isNaN(daysNum) && daysNum > 0) {
          daysNum = Math.min(daysNum, 365);
          const sinceDate = new Date();
          sinceDate.setDate(sinceDate.getDate() - daysNum);
          exampleVars.sinceDateParam = sinceDate.toISOString();
        }
      }
      if (params?.personaId !== undefined) {
        const personaIdNum = parseInt(String(params.personaId), 10);
        if (!isNaN(personaIdNum)) {
          exampleVars.personaIdParam = personaIdNum;
        }
      }
      // Type and limit are interpolated directly into the query by generateQuery, not passed as GQL variables.
      return exampleVars;
    }
  }
};

// --- Resource Handlers ---
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources: Resource[] = [
    {
      uri: "graphql://guide/context",
      name: "BuildBetter Comprehensive Guide",
      description: "The primary guide for AI agents: strategies, schema, tools, prompts, workflows, and best practices for using the BuildBetter MCP.",
      mimeType: "text/markdown"
    },
    {
      uri: "graphql://schema",
      name: "GraphQL Schema Overview (Dynamic)",
      description: "Dynamically lists all available object types in the GraphQL schema.",
      mimeType: "text/markdown"
    },
    // Improvement 7: Schema-visual endpoint
    {
      uri: "graphql://diagram/schema-relationships",
      name: "Schema Relationships Diagram (Visual)",
      description: "A Mermaid diagram visualizing key entity relationships.",
      mimeType: "text/markdown"
    },
    {
      uri: "graphql://schema-diagram",
      name: "Schema Diagram (Visual)",
      description: "Alias for the key entity relationships Mermaid diagram.",
      mimeType: "text/markdown"
    },
  ];
  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const parsedUri = new URL(uri);

  if (parsedUri.protocol === "graphql:") {
    if (parsedUri.pathname === "//schema") {
      try {
        const schema = await getSchemaInfo();
        const objectTypes = filterObjectTypes(schema);
        const content = objectTypes.map((type: GraphQLType) =>
          `# ${type.name}\n${type.description ? type.description + '\n' : ''}`
        ).join('\n\n');
        return { contents: [{ uri: uri, mimeType: "text/markdown", text: content }] };
      } catch (error: unknown) {
        return { contents: [{ uri: uri, text: `Error fetching schema: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    } else if (parsedUri.pathname.startsWith("//type/")) {
      const typeName = parsedUri.pathname.substring("//type/".length);
       if (!typeName) {
         return { contents: [{ uri: uri, text: "Error: Type name missing in URI." }] };
       }
      try {
        const schema = await getSchemaInfo(); 
        const typeDetail = (schema.__schema.types as GraphQLType[]).find(t => t.name === typeName);

        if (!typeDetail) {
          return { contents: [{ uri: uri, text: `Type "${typeName}" not found in schema.` }] };
        }
        let content = `# ${typeDetail.name}\n\n${typeDetail.description ? typeDetail.description + '\n\n' : ''}`;
        
        if (typeDetail.kind === 'OBJECT' || typeDetail.kind === 'INPUT_OBJECT') {
            content += `## Fields\n\n`;
            const fields = await getTypeFields(typeName); 
            if (fields && fields.length > 0) {
              fields.forEach((field) => { 
                content += `### ${field.name}\n**Type:** \`${formatTypeForDisplay(field.type)}\`\n${field.description ? `**Description:** ${field.description}\n` : ''}\n`;
              });
            } else {
              content += "No fields available for this type.\n";
            }
        } else if (typeDetail.kind === 'ENUM') {
            content += `## Enum Values\n\n`;
            const enumTypeData = (schema.__schema.types as any[]).find(t => t.name === typeName && t.kind === 'ENUM');
            if (enumTypeData && enumTypeData.enumValues && enumTypeData.enumValues.length > 0) {
                 enumTypeData.enumValues.forEach((val: {name: string, description?: string}) => {
                     content += `- \`${val.name}\`${val.description ? `: ${val.description}` : ''}\n`;
                 });
            } else {
                content += "No enum values found for this type.\n";
            }
        } else {
            content += `\nKind: ${typeDetail.kind}\n(Further details for this kind are not specifically formatted).`;
        }
        return { contents: [{ uri: uri, mimeType: "text/markdown", text: content }] };
      } catch (error: unknown) {
        return { contents: [{ uri: uri, text: `Error fetching type ${typeName}: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    } else if (parsedUri.pathname === "//guide/context") { // Improvement 6: Resource docs
      const comprehensiveGuide = `
# BuildBetter MCP: Comprehensive AI Agent Guide

This guide provides AI agents with all necessary information to effectively interact with the BuildBetter MCP (Model Context Protocol) server, enabling read-only access to BuildBetter's conversation data.

## 1. Introduction and Key Principles

### Purpose
This MCP allows an AI assistant to query BuildBetter's conversation data (calls/interviews, transcripts, extraction signals like issues or feedback) in a read-only manner. The primary goal is to help users get insights from their customer conversations safely and efficiently. No write operations (mutations) are permitted.

### How to Use This MCP
You will receive tasks or questions from a user. Your general workflow should be:
1.  **Understand the Question:** Clarify the user's intent and the specific information they need.
2.  **Consult Documentation (this guide):** Review the schema, available tools, prompts, and workflow examples to determine the best approach.
3.  **Use Available Tools:** Employ the tools listed in Section 3 to explore the schema, construct queries, and retrieve data.
4.  **Respond with an Answer:** Synthesize the retrieved information into a clear and concise answer for the user.

This guide is your primary reference. Key sections include:
-   **Schema Overview (Section 2):** Understand the data model.
-   **Available Tools (Section 3):** Learn about direct actions you can perform.
-   **Prompt Templates (Section 4):** Discover guided task recipes.
-   **Workflow Examples (Section 5):** See how to combine tools for common scenarios.

### Capabilities at a Glance
-   **Schema Exploration:** Discover data types and their fields.
-   **GraphQL Querying:** Execute custom GraphQL queries (read-only).
-   **Keyword Search:** Search through extraction text.
-   **Pre-defined Query Templates:** Use templates for common data retrieval tasks.
-   **Guided Prompts:** Get step-by-step instructions for specific tasks.

### Important Constraints
-   **Read-Only Access:** You can only fetch data; mutations or any data-altering operations are blocked.
-   **Persona Filtering:** By default, data includes voices from both customers and internal team members. You can filter by \`persona_id\` if a query needs to focus on a specific speaker type (see Persona IDs in Section 6).

## 2. Schema Overview and Data Model

Understanding the BuildBetter data model is crucial for effective querying.

### Main Entities
-   **Interview (Call):** Represents a customer call (or meeting) record.
    -   *Key Fields:* \`id\`, \`name\`, \`display_ts\` (timestamp for ordering), \`recorded_at\`, \`short_summary\`, \`attendees\`.
    -   *Note:* "Call" is often used interchangeably with "Interview." The GraphQL schema primarily uses \`interview\`.
-   **Extraction (Signal):** A specific insight, snippet, or piece of information extracted from an interview.
    -   *Key Fields:* \`id\`, \`summary\` (text content), \`display_ts\`, \`sentiment\`, \`call_id\` (links to Interview), \`types\` (links to Extraction Type).
-   **Extraction Type:** The category of an extraction.
    -   *Examples:* "Issue", "Feature Request", "Objection", "Positive Feedback".
    -   *Key Fields:* \`name\`.
-   **Person:** An individual who participated in an interview.
    -   *Key Fields:* \`id\`, \`first_name\`, \`last_name\`, \`email\`, \`persona_id\` (indicates role, e.g., Customer or Team Member).
-   **Company:** A customer's organization, linked to Persons.
    -   *Key Fields:* \`id\`, \`name\`.
-   **Interview Attendee:** A join table linking an Interview to a Person.
-   **Extraction Type Join:** A join table linking an Extraction to one or more Extraction Types.

### Relationships Diagram (Mermaid)

\`\`\`mermaid
flowchart TB
  subgraph "Core Entities & Relationships"
    interview["Interview (Call)"]
    extraction["Extraction (Signal)"]
    person["Person"]
    company["Company"]
    extraction_type["Extraction Type"]
    
    interview --o|Contains| extraction
    interview --o|Attended By (via interview_attendee)| person
    person --o|Belongs To| company
    extraction --o|Categorized As (via extraction_type_join)| extraction_type
    extraction --o|Spoken During| interview_monologue["Interview Monologue"]
    interview_monologue --o|Part Of| interview
    interview_monologue --o|Spoken By (via speaker)| person
  end

  subgraph "Example Key Fields"
    interview_fields["id, name, display_ts, short_summary"]
    extraction_fields["id, summary, display_ts, sentiment, call_id"]
    person_fields["id, first_name, last_name, email, persona_id"]
    company_fields["id, name"]
    extraction_type_fields["id, name (e.g., 'Issue')"]
    
    interview --- interview_fields
    extraction --- extraction_fields
    person --- person_fields
    company --- company_fields
    extraction_type --- extraction_type_fields
  end
\`\`\`

### Common Fields and Meanings
-   \`id\`: Unique identifier for an entity.
-   \`name\`: Descriptive name (e.g., for an interview or company).
-   \`summary\`: Text content, typically for an extraction or a short summary of an interview.
-   \`text\`: Often used for the main content of an extraction or monologue.
-   \`display_ts\`: A timestamp used for chronological ordering of events (preferred for sorting).
-   \`created_at\`, \`updated_at\`: Standard timestamps for record creation and modification.
-   \`persona_id\`: Numeric ID indicating the role of a speaker (Person). See Section 6 for common values.
-   \`sentiment\`: Often a numeric or categorical representation of sentiment associated with an extraction.

### How to Explore the Schema Dynamically
While this guide provides an overview, you can always get live schema details:
1.  **List All Object Types:** Use the \`list-types\` tool.
2.  **Get Fields for a Specific Type:**
    -   Use \`find-fields(typeName: "YourTypeName")\`.
    -   Or, use \`read-resource(uri: "graphql://type/YourTypeName")\`.
3.  **Schema Overview Resource:** \`read-resource(uri: "graphql://schema")\` lists types.
4.  **Visual Schema Diagram:** \`read-resource(uri: "graphql://diagram/schema-relationships")\` shows the Mermaid diagram.
5.  **Enum Values:** To discover all possible values for an enum type (like extraction types), you can query the schema. For example, for \`extraction_type_type_enum\` (actual name might vary, check \`graphql://type/extraction_type\` to find the enum type for its \`name\` field), use a GraphQL introspection query: \`{ __type(name: "extraction_type_type_enum") { name kind enumValues { name description } } }\` via the \`run-query\` tool. Or read the resource for the enum type itself: \`read-resource(uri: "graphql://type/extraction_type_type_enum")\`.

## 3. Available Tools (Functions) and Their Usage

Tools are direct actions you can perform.

-   **\`run-query\`**: Executes a GraphQL query. Args: \`{ query: string, variables?: object }\`. Mutations blocked.
-   **\`list-types\`**: Lists all queryable object type names. No args.
-   **\`find-fields\`**: Gets fields and GraphQL types for an object type. Args: \`{ typeName: string }\`.
-   **\`build-query\`**: Generates a basic GraphQL query. Args: \`{ typeName: string, fields: string[], limit?: number, filter?: object }\`. Note: Does not support nested fields (e.g., 'parent.child'); use manual query for those.
-   **\`search-extractions\`**: Keyword search in extraction text. Args: \`{ phrase: string, type?: string, limit?: number, personaIds?: number[] }\`.
-   **\`recent-conversation-with\`**: Finds most recent call(s) a person attended. Args: \`{ name: string, limit?: number (default 1) }\`.
-   **\`topic-conversations\`**: Finds calls discussing a topic (searches extraction summaries). Args: \`{ topic: string, limit?: number (default 5, max 25) }\`.
-   **\`top-customer-issues\`**: Retrieves recent 'Issue'-type extractions from customers. Args: \`{ days?: number (default 30, max 365), limit?: number (default 10, max 50) }\`.
-   **\`query-template\`**: Generates a query from a template. Args: \`{ template: string, parameters?: object }\`.
    -   Available templates:
        -   \`find-person\`: Params: \`{ name: string }\`.
        -   \`last-call-with-person\`: Params: \`{ name: string }\`. Uses specific query for last call.
        -   \`recent-calls\`: Params: \`{ limit?: number }\`.
        -   \`call-with-topic\`: Params: \`{ topic: string, limit?: number }\`.
        -   \`top-customer-issues\`: Params: \`{ days?: number, limit?: number }\`. Returns query string expecting variables.
        -   \`signal-by-type\`: Params: \`{ type: string, limit?: number, days?: number }\`.
-   **\`nl-query\`**: Natural language to query. Args: \`{ description: string }\`. Handles simple patterns. If no specific pattern matches, it attempts a general topic search using the \`call-with-topic\` template.
-   **\`read-resource\`**: Fetches documentation. Args: \`{ uri: string }\`. Aliases: \`open-resource\`.
-   **\`validate-query\`**: Checks GraphQL query validity (syntax, read-only). Args: \`{ query: string }\`.
-   **\`help\`**: Guidance on MCP usage. Args: \`{ topic?: string ("queries", "schema", "extractions", "tools", "prompts") }\`.
-   **\`schema-overview\`**: Returns a markdown Mermaid diagram of key schema relationships. (Same as \`graphql://diagram/schema-relationships\`).

### When to Use Which Tool
-   **Direct Data Tools:** Use \`recent-conversation-with\`, \`top-customer-issues\`, \`topic-conversations\` for matching requests.
-   **Query Assistance:** \`query-template\` for known structures, \`nl-query\` for simple language (review output).
-   **Full Control:** \`run-query\` for custom GraphQL.
-   **Schema Discovery:** \`list-types\`, \`find-fields\`, \`read-resource\` (for types/diagram), \`schema-overview\`.
-   **Prompts (Section 4):** For guided recipes if unsure.

## 4. Prompt Templates (Guided Tasks)

Prompts provide instructions and suggested queries, not direct data.

### What Are Prompts?
-   **Purpose:** Guide common tasks with pre-defined recipes.
-   **Output:** Instructional message, often with a GraphQL query to run via \`run-query\`.

### Available Prompts
-   **\`recent-calls\`**: Guide to list recent calls. Args: \`{ limit?: number }\`.
-   **\`call-details\`**: Guide for specific call details. Args: \`{ id: string }\`.
-   **\`call-transcript\`**: Guide for full call transcript. Args: \`{ id: string }\`.
-   **\`search-transcript\`**: Guide to search in a transcript. Args: \`{ id: string, phrase: string }\`.
-   **\`call-extractions\`**: Guide for a call's extractions. Args: \`{ id: string, type?: string }\`.
-   **\`signal-frequency\`**: Guide for extraction counts per type. No args.
-   **\`feature-requests-by-date\`**: Guide for feature requests in date range. Args: \`{ startDate: string, endDate: string }\`.
-   **\`recent-issues\`**: Guide for recent 'Issue' extractions. Args: \`{ limit?: number }\`.
-   **\`feature-requests\`**: Guide for recent 'Feature Request' extractions. Args: \`{ limit?: number }\`.
-   **\`recent-objections\` / \`top-objections\`**: Guide for 'Objection' extractions. Args: \`{ days?: number (default 30, max 365) }\` or \`{ startDate, endDate }\`.
-   **\`customer-objections\`**: Guide for customer 'Objection' extractions. Args: \`{ days?: number (default 30, max 365) }\`.
-   **\`explore-schema\`**: Mini-checklist for schema exploration. No args.
-   **\`context-guide\`**: Reminds to open this main guide. No args.

### Using Prompts Effectively
Optional shortcuts. Review suggested queries. You can often achieve results directly with tools.

## 5. Workflow Examples and Best Practices
(Content from original specification, slightly condensed for brevity but retaining core examples for "Last call with Alice" and "Top customer objections")

### Example 1: "What was the last call Alice participated in, and what issues were discussed in it?"
1.  **Goal:** Alice's last call + issues from it.
2.  **Find Call:** Use \`recent-conversation-with(name: "Alice", limit: 1)\`. Get call ID (e.g., "12345").
3.  **Find Issues:** Use \`call-extractions\` prompt \`(id: "12345", type: "Issue")\` to get a query, then \`run-query\`.
4.  **Respond:** Combine info.

### Example 2: "Show me top customer objections in the past quarter."
1.  **Goal:** "Objection" extractions by Customers, last ~90 days.
2.  **Tool/Prompt:** Use \`customer-objections\` prompt \`(days: 90)\` for a guided query. Or use \`query-template(template: "top-customer-issues", parameters: { days: 90, type: "Objection" ...})\` if template is adapted, or build manually.
3.  **Execute:** \`run-query\` with the (prompt-suggested) GraphQL.
4.  **Present:** List objections.

### General Workflow Advice
-   Start broad, then narrow for schema exploration.
-   Validate complex custom queries (\`validate-query\`).
-   Iterate; don't make queries overly complex at once.
-   Use \`limit\` for manageable responses.

## 6. Additional References

### Extraction Types Glossary (Common Examples)
This list may not be exhaustive. Use schema exploration if you encounter other types.
-   **Issue:** A customer pain point, problem, bug report, or complaint.
-   **Feature Request:** A customer's request or suggestion for a new feature or enhancement.
-   **Objection:** A sales objection or concern raised by a customer/prospect.
-   **Positive Feedback:** Positive comments or praise from a customer.
-   **Action Item:** A task or follow-up identified during a conversation.
-   **Question:** A question asked by a participant.
-   **Pricing:** Mentions related to pricing, cost, or budget.

### Persona IDs Reference
Used in \`person.persona_id\` field to filter speakers.
-   246: Customer
-   247: Team Member (Internal User/Employee)
When a query needs to focus on what customers said, filter using \`persona_id: {_eq: 246}\` (or \`_in: [246]\`).

### Help System Reminder
The \`help\` tool is your friend!
-   \`help()\` for general overview and topics.
-   \`help(topic: "queries")\`: Tips on using \`query-template\`, \`nl-query\`, and \`run-query\`.
-   \`help(topic: "schema")\`: Reminders on \`list-types\`, \`find-fields\`, and reading type resources.
-   \`help(topic: "extractions")\`: Info on common extraction types and how to filter them.

This comprehensive guide should equip you to effectively use the BuildBetter MCP. Remember to consult it often.
`;
      return { contents: [{ uri: uri, mimeType: "text/markdown", text: comprehensiveGuide }] };
    } else if (parsedUri.pathname === "//diagram/schema-relationships" || parsedUri.pathname === "//schema-diagram") { // Improvement 7
      const mermaidDiagramText = `
\`\`\`mermaid
flowchart TB
  subgraph "Core Entities & Relationships"
    interview["Interview (Call)"]
    extraction["Extraction (Signal)"]
    person["Person"]
    company["Company"]
    extraction_type["Extraction Type"]
    interview_attendee["Interview Attendee (Join)"]
    extraction_type_join["Extraction Type Join (Join)"]
    interview_monologue["Interview Monologue"]


    interview --o|Contains Many| extraction
    interview --o|Links Via| interview_attendee
    interview_attendee --o|To Person| person
    person --o|Belongs To| company
    extraction --o|Links Via| extraction_type_join
    extraction_type_join --o|To Type| extraction_type
    
    interview --o|Has Many| interview_monologue
    interview_monologue --o|Links to Speaker| person
    extraction --o|Can Link To| interview_monologue
  end

  subgraph "Key Fields (Examples)"
    interview_fields["id, name, display_ts, short_summary"]
    extraction_fields["id, summary, display_ts, sentiment, call_id"]
    person_fields["id, first_name, last_name, email, persona_id"]
    extraction_type_fields["id, name (e.g., 'Issue', 'Feature Request')"]
  end
  
  interview --- interview_fields
  extraction --- extraction_fields
  person --- person_fields
  extraction_type --- extraction_type_fields
\`\`\`
`;
      return { contents: [{ uri: uri, mimeType: "text/markdown", text: mermaidDiagramText }] };
    }
  }

   throw { code: -32002, message: "Resource not found", data: { uri } };
});
// --- End Resource Handlers ---


// --- Tool Handlers ---
const toolsList: Tool[] = [
  {
    name: "run-query",
    description: "Execute a read-only GraphQL query. For complex needs not covered by other tools.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The GraphQL query string to execute." },
        variables: { type: "object", description: "Optional variables for the GraphQL query." }
      },
      required: ["query"]
    }
  },
  {
    name: "list-types",
    description: "List all queryable object type names in the GraphQL schema.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "find-fields",
    description: "Get a detailed schema overview for a specified GraphQL object, input object, or enum type, including fields, relationships, and common query patterns. E.g. find-fields(typeName: \"interview\")",
    inputSchema: {
      type: "object",
      properties: {
        typeName: { type: "string", description: "The GraphQL object, input object, or enum type name." }
      },
      required: ["typeName"]
    }
  },
  {
    name: "build-query",
    description: "Build a simple GraphQL query string for a specific type. Useful for quick query drafting. Does not support nested fields.",
    inputSchema: {
      type: "object",
      properties: {
        typeName: { type: "string", description: "Name of the GraphQL type to query." },
        fields: { type: "array", items: { type: "string" }, description: "Array of field names to include." },
        limit: { type: "number", description: "Optional: limit number of results." },
        filter: { type: "object", description: "Optional: filter criteria (structure depends on schema)." }
      },
      required: ["typeName", "fields"]
    }
  },
  {
    name: "search-extractions",
    description: "Keyword search through extraction (signal) text. Can filter by extraction type (enum value, no quotes) or speaker persona.",
    inputSchema: {
      type: "object",
      properties: {
        phrase: { type: "string", description: "Text to search for (case-insensitive)." },
        type: { type: "string", description: "Optional: Extraction type name (enum value, e.g., 'Issue', 'FeatureRequest')." },
        limit: { type: "number", description: "Optional: Maximum number of results (default 10, max 50)." },
        personaIds: { type: "array", items: { type: "number" }, description: "Optional: Array of persona_ids to filter speaker by (e.g., [246] for Customer)." }
      },
      required: ["phrase"]
    }
  },
  {
    name: "recent-conversation-with",
    description: "Find the most recent call(s) (interviews) a specific person attended. Searches by person's name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "First or last name of the person." },
        limit: { type: "number", description: "Optional: Maximum number of conversations to return (default: 1, max 10)." }
      },
      required: ["name"]
    }
  },
  {
    name: "topic-conversations",
    description: "Find recent calls (interviews) discussing a specific topic by searching extraction summaries.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic/keyword to search for in extraction summaries." },
        limit: { type: "number", description: "Optional: Maximum number of conversations (via extractions) to return (default: 5, max 25)." }
      },
      required: ["topic"]
    }
  },
  {
    name: "query-template",
    description: "Generate a GraphQL query string from a preset template, with contextual information. Templates: find-person, last-call-with-person, recent-calls, call-with-topic, signal-by-type.",
    inputSchema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description: "Template name (e.g., 'find-person', 'recent-calls')."
        },
        parameters: {
          type: "object",
          description: "Parameters for the chosen template (e.g., { name: 'Alice' } for 'find-person')."
        }
      },
      required: ["template"]
    }
  },
  {
    name: "nl-query",
    description: "Generate a GraphQL query from a natural language description. Handles simple patterns. If no specific pattern matches, attempts a general topic search.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Natural language description of the desired query." }
      },
      required: ["description"]
    }
  },
  {
    name: "read-resource",
    description: "Fetch a documentation resource by URI (e.g., 'graphql://guide/context', 'graphql://schema', 'graphql://diagram/schema-relationships'). Alias: open-resource.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "URI of the resource to read." }
      },
      required: ["uri"]
    }
  },
  {
    name: "open-resource", 
    description: "Alias for read-resource. Fetches a documentation resource by URI.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "URI of the resource to read." }
      },
      required: ["uri"]
    }
  },
  {
    name: "validate-query",
    description: "Check if a GraphQL query string is syntactically valid and read-only before execution.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The GraphQL query string to validate." }
      },
      required: ["query"]
    }
  },
  {
    name: "help",
    description: "Get help on using the BuildBetter MCP. Use without args for general help, or with a topic (e.g., 'queries', 'schema', 'extractions').",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string", description: "Optional: Specific topic for help ('queries', 'schema', 'extractions', 'tools', 'prompts')." } }
    }
  },
  {
    name: "schema-overview",
    description: "Return a markdown Mermaid diagram describing key schema relationships. (Same as reading graphql://diagram/schema-relationships).",
    inputSchema: { type: "object", properties: {} }
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
       return { content: [{ type: "text", text: "Error: 'query' argument is required for run-query." }], isError: true };
    }

    const queryText = query.trim().toLowerCase();
    if (queryText.startsWith('mutation') || queryText.includes('mutation {')) {
      return { content: [{ type: "text", text: "Error: Only read-only queries (query, subscription) are allowed. Mutations are blocked." }], isError: true };
    }
    try {
      const result: any = await graphqlClient.request(query, variables);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      let errorMsg = error instanceof Error ? error.message : String(error);
      let userFriendlyMessage = "An error occurred while executing the query.";
      const originalErrorForContext = `Original error: ${errorMsg}`;
      let suggestions: string[] = [
        `Review your query for syntax errors. You can use the \`validate-query\` tool. `,
        `Ensure all types and fields exist and are correctly spelled. Use \`find-fields(typeName: "YourType")\` to explore the schema. `,
        `Check the main guide for query patterns and examples: \`read-resource(uri: "graphql://guide/context")\`.`
      ];

      const hasuraPathMatch = errorMsg.match(/\$\.selectionSet\.([^\s]+)/);
      if (hasuraPathMatch && hasuraPathMatch[1]) {
        suggestions.unshift(`The error might be related to the path: ${hasuraPathMatch[1]}.`);
      }

      if (errorMsg.includes("expected an enum value") && (errorMsg.includes("but found a string") || errorMsg.includes("but found String"))) {
        userFriendlyMessage = "Invalid Enum Value Usage:";
        suggestions = [
          "Enum values in GraphQL queries should be used directly without quotes (e.g., `type: {_eq: Issue}` NOT `type: {_eq: \"Issue\"}`).",
          "Ensure the enum value is spelled correctly and is a valid member of its enum type.",
          "To find the correct enum type name and its valid values, first identify the field expecting the enum. Then use `find-fields(typeName: \"TheEnumTypeName\")` to list all valid, unquoted enum values.",
          "Example: If a field `status` on type `Task` expects an enum `TaskStatus`, you would use `find-fields(typeName: \"TaskStatus\")`."
        ];
      } else if (errorMsg.includes("field not found") || errorMsg.includes("Cannot query field")) {
        const fieldMatch = errorMsg.match(/field '([^']+)' not found/) || errorMsg.match(/Cannot query field "([^"]+)" on type/);
        const typeMatch = errorMsg.match(/on type ['\"]([^'\"]+)['\"]/);
        const fieldName = fieldMatch && fieldMatch[1] ? fieldMatch[1] : "unknown_field";
        const typeName = typeMatch && typeMatch[1] ? typeMatch[1] : null;

        userFriendlyMessage = `Field Error: Field '${fieldName}' not found${typeName ? ` on type '${typeName}'` : ''}.`;
        suggestions = []; // Reset suggestions for this specific error type

        if (typeName) {
          const similar = await findSimilarFields(typeName, fieldName);
          if (similar.length > 0) {
            suggestions.push(`Did you mean one of these fields on type '${typeName}': ${similar.join(', ')}?`);
          }
          suggestions.push(`To see all available fields for type '${typeName}', use the tool: \`find-fields(typeName: "${typeName}")\`.`);
        } else {
          suggestions.push("Check the spelling of the field and ensure it exists on the queried type.");
          suggestions.push("Use `find-fields(typeName: \"RelevantType\")` to explore the schema.");
        }
        suggestions.push("Verify that if it\'s a nested field, the parent fields are correct and lead to this field.");

      } else if (errorMsg.includes("unexpected subselection")) { // Basic handling for unexpected subselection
        const subselectionFieldMatch = errorMsg.match(/on field \"([^\"]+)\"/);
        const fieldName = subselectionFieldMatch && subselectionFieldMatch[1] ? subselectionFieldMatch[1] : "unknown field";
        userFriendlyMessage = `Invalid Query Structure: Unexpected sub-selection on field '${fieldName}'.`;
        suggestions = [
          `The field '${fieldName}' is likely a scalar type (like String, Int, Boolean, Enum) or a custom scalar, and cannot have further fields selected within { ... } block.`, 
          `Remove the sub-selection (the { ... } part) for the field '${fieldName}'.`, 
          `Use \`find-fields(typeName: "ParentTypeNameOf_${fieldName}")\` to check the type of '${fieldName}'. If it's a scalar or enum, it cannot have sub-fields.`
        ];
      }
      
      return {
        content: [
          { type: "text", text: `${userFriendlyMessage}` },
          { type: "text", text: `Suggestions:\n- ${suggestions.join('\n- ' )}` },
          { type: "text", text: originalErrorForContext }
        ],
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
  } else if (toolName === "build-query") { // Improvement 3: Nested-field error
    const typeName = args?.typeName as string;
    const fields = args?.fields as string[] | undefined;
    const limit = args?.limit as number | undefined;
    const filter = args?.filter as Record<string, any> | undefined;

    if (!typeName || !fields || fields.length === 0) {
       return { content: [{ type: "text", text: "Error: 'typeName' and 'fields' arguments are required for build-query." }], isError: true };
    }
    if (fields.some(f => f.includes('.'))) {
      return { content: [{ type: "text", text: "Error: Nested fields (e.g., 'parent.child') are not supported by build-query. Please write the query manually or use run-query." }], isError: true };
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
        const suggestions = await findSimilarFields(typeName, invalidFields[0]);
        let suggestionText = "";
        if(suggestions.length > 0) suggestionText = ` Did you mean one of: ${suggestions.join(', ')}?`;
        return { content: [{ type: "text", text: `Error: Invalid field(s) for type "${typeName}": ${invalidFields.join(', ')}.${suggestionText} Check available fields with find-fields.` }], isError: true };
      }
      let queryParams = '';
      const params = [];
      if (limit !== undefined && Number.isInteger(limit) && limit > 0) params.push(`limit: ${Math.min(limit, 100)}`); // Guardrail limit
      if (filter && Object.keys(filter).length > 0) {
        const filterStr = Object.entries(filter).map(([k, v]) => {
          if (typeof v === 'string' && !v.startsWith('{') && !String(v).match(/^[A-Za-z_][A-Za-z0-9_]*$/)) { // if not an enum-like bare word
             return `${k}: {_eq: ${JSON.stringify(v)}}`; 
          }
          return `${k}: ${typeof v === 'object' ? JSON.stringify(v).replace(/"([^"]+)":/g, '$1:') : v}`; 
        }).join(', ');
        if (filterStr) params.push(`where: {${filterStr}}`);
      }
      if (params.length > 0) queryParams = `(${params.join(', ')})`;
      
      const queryRootField = typeName; 
      const queryString = `query Get${selectedType.name} { ${queryRootField}${queryParams} { ${fields.join('\n    ')} } }`;
      return { content: [{ type: "text", text: queryString.trim() }] };
    } catch (error: unknown) {
      return { content: [{ type: "text", text: `Error building query: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  } else if (toolName === "schema-overview" || (toolName === "read-resource" && (args?.uri === "graphql://diagram/schema-relationships" || args?.uri === "graphql://schema-diagram"))) {
    const mermaidDiagramText = `
\`\`\`mermaid
flowchart TB
  subgraph "Core Entities & Relationships"
    interview["Interview (Call)"]
    extraction["Extraction (Signal)"]
    person["Person"]
    company["Company"]
    extraction_type["Extraction Type"]
    interview_attendee["Interview Attendee (Join)"]
    extraction_type_join["Extraction Type Join (Join)"]
    interview_monologue["Interview Monologue"]


    interview --o|Contains Many| extraction
    interview --o|Links Via| interview_attendee
    interview_attendee --o|To Person| person
    person --o|Belongs To| company
    extraction --o|Links Via| extraction_type_join
    extraction_type_join --o|To Type| extraction_type
    
    interview --o|Has Many| interview_monologue
    interview_monologue --o|Links to Speaker| person
    extraction --o|Can Link To| interview_monologue
  end

  subgraph "Key Fields (Examples)"
    interview_fields["id, name, display_ts, short_summary"]
    extraction_fields["id, summary, display_ts, sentiment, call_id"]
    person_fields["id, first_name, last_name, email, persona_id"]
    extraction_type_fields["id, name (e.g., 'Issue', 'Feature Request')"]
  end
  
  interview --- interview_fields
  extraction --- extraction_fields
  person --- person_fields
  extraction_type --- extraction_type_fields
\`\`\`
`;
      return { content: [{ type: "text", text: `# Schema Relationships Diagram\n\n${mermaidDiagramText}` }] };
  } else if (toolName === "search-extractions") { // Improvement 2: Enum helper, Improvement 8: Date guardrails
    const phrase = args?.phrase as string;
    let extType = args?.type as string | undefined;
    let limit = parseInt(String(args?.limit ?? 10), 10);
    if (isNaN(limit) || limit <= 0) limit = 10;
    limit = Math.min(limit, 50); // Cap limit

    const personaIds = args?.personaIds as number[] | undefined;
    if (!phrase) {
      return { content: [{ type: "text", text: "Error: 'phrase' argument is required for search-extractions." }], isError: true };
    }

    if (extType) {
      extType = normalizeEnumValue(extType); // Normalize enum value
    }

    const extractionFields = await getTypeFields("extraction");
    const smartSearchableFields = ["summary", "exact_quote", "text", "context"]
      .filter(fieldName => extractionFields.some(ef => ef.name === fieldName));

    let whereClauses: string[] = [];
    if (smartSearchableFields.length > 0) {
      const orConditions = smartSearchableFields.map(field =>
        `{ ${field}: {_ilike: "%${phrase}%"} }`
      ).join(", ");
      whereClauses.push(smartSearchableFields.length > 1 ? `_or: [${orConditions}]` : orConditions.replace(/^\{|\}$/g, '')); // remove {} if single
    } else {
       const defaultTextField = extractionFields.find(f => f.name === "summary" || f.name === "text")?.name;
       if (defaultTextField) {
        whereClauses.push(`${defaultTextField}: {_ilike: "%${phrase}%"}`);
       } else {
        return { content: [{ type: "text", text: "Error: No suitable text field found on 'extraction' for searching." }], isError: true };
       }
    }
    
    if (extType) {
      // Assuming 'types: { type: { name: ... } }' is the path. This might need schema-awareness.
      // For direct GQL interpolation, enum must be bare.
      whereClauses.push(`types: { type: { name: {_eq: ${extType}} } }`);
    }
    if (personaIds && personaIds.length > 0 && extractionFields.some(f => f.name === "speaker")) {
      whereClauses.push(`speaker: { person: { persona_id: {_in: [${personaIds.join(',')}]} } }`);
    }

    const whereCombined = whereClauses.join(", ");
    
    const selectionFields: string[] = ["id", "summary", "display_ts"];
    if (extractionFields.some(f => f.name === "text")) selectionFields.push("text");
    if (extractionFields.some(f => f.name === "sentiment")) selectionFields.push("sentiment");
    if (extractionFields.some(f => f.name === "call")) { 
      selectionFields.push("call { id name display_ts company { name } }");
    } else if (extractionFields.some(f => f.name === "interview")) {
      selectionFields.push("interview { id name display_ts company { name } }");
    }
    selectionFields.push("types { type { name } }");


    const queryString = gql`
      query SearchExtractions {
        extraction(
          where: { ${whereCombined} }
          order_by: { display_ts: desc }
          limit: ${limit}
        ) {
          ${selectionFields.join("\n          ")}
        }
      }`;

    try {
      const result = await graphqlClient.request(queryString);
      return {
        content: [
          { type: "text", text: "Executed query:\n\n```graphql\n" + queryString + "\n```" },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error: unknown) { // Improvement 10: README snippet in errors
        let errorMsg = error instanceof Error ? error.message : String(error);
        let actionableHint = `For schema issues, try \`help(topic: "schema")\` or review the main guide at \`graphql://guide/context\`.`;
        const hasuraPathMatch = errorMsg.match(/\$\.selectionSet\.([^\s]+)/);
        if (hasuraPathMatch && hasuraPathMatch[1]) {
            actionableHint = `Failing path might be related to: ${hasuraPathMatch[1]}. ${actionableHint}`;
        }
         if (errorMsg.includes("expected an enum value") && (errorMsg.includes("but found a string") || errorMsg.includes("but found String"))) {
            errorMsg = `Error: Invalid enum value. Enum values should be used directly without quotes (e.g., \`type_name: {_eq: Issue}\` not \`type_name: {_eq: "Issue"}\`). Check available enum values using \`find-fields(typeName: "YourEnumTypeName")\`. Original error: ${errorMsg}`;
        }
      return {
        content: [{ type: "text", text: `Error executing search: ${errorMsg}\nQuery attempted:\n${queryString}\n${actionableHint}` }],
        isError: true,
      };
    }
  } else if (toolName === "recent-conversation-with") { // Improvement 8: Date guardrails (limit here)
    const name = args?.name as string;
    let interviewLimit = parseInt(String(args?.limit ?? 1), 10);
    if (isNaN(interviewLimit) || interviewLimit <= 0) interviewLimit = 1;
    interviewLimit = Math.min(interviewLimit, 10); // Cap limit

    const personSearchLimit = 5;

    if (!name) {
      return { content: [{ type: "text", text: "Error: 'name' argument is required for recent-conversation-with." }], isError: true };
    }
    
    try {
      const query = gql`
        query FindPersonConversations($nameParam: String!, $personLimitParam: Int!, $interviewLimitParam: Int!) {
          person(
            where: {_or: [{first_name: {_ilike: $nameParam}}, {last_name: {_ilike: $nameParam}}]},
            limit: $personLimitParam 
          ) {
            id
            first_name
            last_name
            email
            company { name }
            interview_attendees(order_by: {interview: {display_ts: desc}}, limit: $interviewLimitParam) {
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
      const variables = {
        nameParam: `%${normalizeEnumValue(name)}%`, // Normalize name input
        personLimitParam: personSearchLimit,
        interviewLimitParam: interviewLimit
      };
      
      const result = await graphqlClient.request(query, variables);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error finding conversations with ${name}: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  } else if (toolName === "top-customer-issues") { // Improvement 2, 8
    let limit = parseInt(String(args?.limit ?? 10), 10);
    if (isNaN(limit) || limit <=0) limit = 10;
    limit = Math.min(limit, 50);

    let days = parseInt(String(args?.days ?? 30), 10);
    if (isNaN(days) || days <=0) days = 30;
    days = Math.min(days, 365); // Guardrail days
    
    const issueTypeName = normalizeEnumValue("Issue");
    const customerPersonaId = 246;

    try {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
      const formattedSinceDate = sinceDate.toISOString(); 

      const variables = {
        limitParam: limit,
        // issueTypeParam: issueTypeName, // No longer passing as GQL variable
        sinceDateParam: formattedSinceDate,
        customerPersonaIdParam: customerPersonaId
      };
      
      const query = gql`
        query TopCustomerIssuesTool($limitParam: Int!, $sinceDateParam: timestamp, $customerPersonaIdParam: Int!) { # Removed $issueTypeParam
          extraction(
            where: {
              _and: [
                { types: { type: { name: { _eq: issue } } } },  // Hardcoded lowercase issue
                { display_ts: { _gte: $sinceDateParam } },
                { attendee: { person: { persona_id: { _eq: $customerPersonaIdParam } } } } // Changed speaker to attendee
              ]
            },
            order_by: {display_ts: desc},
            limit: $limitParam
          ) {
            id
            summary
            display_ts
            sentiment
            call { id name company { name } }
            attendee { person { first_name last_name company { name } } } # Added attendee for output
          }
        }
      `;
        // logToLoop(`Executing TopCustomerIssuesTool with variables: ${JSON.stringify(variables)} and query: ${query}`);
        const result: any = await graphqlClient.request(query, variables);
        // logToLoop(`Result from TopCustomerIssuesTool: ${JSON.stringify(result)}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: unknown) {
        let errorMsg = error instanceof Error ? error.message : String(error);
        let actionableHint = `For schema issues, try \`help(topic: "schema")\` or review the main guide at \`graphql://guide/context\`.`;
        const hasuraPathMatch = errorMsg.match(/\$\.selectionSet\.([^\s]+)/);
        if (hasuraPathMatch && hasuraPathMatch[1]) {
            actionableHint = `Failing path might be related to: ${hasuraPathMatch[1]}. ${actionableHint}`;
        }
      return {
        content: [{ type: "text", text: `Error fetching top customer issues: ${errorMsg}\n${actionableHint}` }],
        isError: true
      };
    }
  } else if (toolName === "topic-conversations") { // Improvement 8
    const topic = args?.topic as string;
    let limit = parseInt(String(args?.limit ?? 5), 10);
    if (isNaN(limit) || limit <= 0) limit = 5;
    limit = Math.min(limit, 25); // Cap limit


    if (!topic) {
      return { content: [{ type: "text", text: "Error: 'topic' argument is required for topic-conversations." }], isError: true };
    }

    try {
      const variables = {
        topicParam: `%${normalizeEnumValue(topic)}%`,
        limitParam: limit
      };
      const query = gql`
        query CallsWithTopic($topicParam: String!, $limitParam: Int!) {
          extraction(
            where: {
              summary: {_ilike: $topicParam} 
            },
            order_by: {display_ts: desc}, 
            limit: $limitParam
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
      return { content: [{ type: "text", text: "Error: 'template' argument is required for query-template." }], isError: true };
    }
    const templateDefinition = queryTemplates[templateName];
    if (!templateDefinition) {
      return {
        content: [{ type: "text", text: `Template '${templateName}' not found. Available templates: ${Object.keys(queryTemplates).join(", ")}` }],
        isError: true
      };
    }
    try {
      const queryStr = templateDefinition.generateQuery(parameters);
      
      let responseText = `Template: ${templateName}\\nDescription: ${templateDefinition.description}\\n`;
      
      responseText += "\\nParameters Provided:\\n";
      if (Object.keys(parameters).length > 0) {
        templateDefinition.parameters.forEach(pInfo => {
          if (parameters[pInfo.name] !== undefined) {
            responseText += `  - ${pInfo.name}: ${parameters[pInfo.name]} (Type: ${pInfo.type}${pInfo.description ? `, ${pInfo.description}` : ''})\\n`;
          }
        });
      } else {
        responseText += "  (No parameters provided, using defaults where applicable)\\n";
      }
      
      responseText += "\\nGenerated query:\\n```graphql\\n" + queryStr + "\\n```";
      
      if (templateDefinition.getExampleVariables) {
        const exampleVars = templateDefinition.getExampleVariables(parameters);
        if (Object.keys(exampleVars).length > 0) {
          responseText += `\\n\\nRecommended GraphQL variables for this query:\\n\`\`\`json\\n${JSON.stringify(exampleVars, null, 2)}\\n\`\`\``;
        }
      }
      return { content: [{ type: "text", text: responseText }] };
    } catch (error: unknown) {
      return {
        content: [{ type: "text", text: `Error generating query from template '${templateName}': ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  } else if (toolName === "find-fields") {
    const typeName = args?.typeName as string;
    if (!typeName) {
      return { content: [{ type: "text", text: "Error: 'typeName' argument is required for find-fields." }], isError: true };
    }
    try {
      const schema = await getSchemaInfo(); // Ensure schema is fetched
      const typeDetail = (schema.__schema.types as GraphQLType[]).find(t => t.name === typeName);

      if (!typeDetail) {
        return { content: [{ type: "text", text: `Type '${typeName}' not found.` }] };
      }

      let output = `=== ${typeName} SCHEMA ===\\n`;
      if (typeDetail.description) {
        output += `Description: ${typeDetail.description}\\n`;
      }
      output += `Kind: ${typeDetail.kind}\\n\\n`;

      const fields = await getTypeFields(typeName); // This gets fields for OBJECT/INPUT_OBJECT and values for ENUM

      if (typeDetail.kind === 'ENUM') {
        output += `ENUM VALUES:\\n`;
        if (fields.length > 0) {
          fields.forEach(val => { // fields for ENUM type are its values
            output += `- \`${val.name}\`${val.description ? ` - ${val.description}` : ''}\\n`;
          });
        } else {
          output += "No enum values found for this type.\\n";
        }
      } else if (typeDetail.kind === 'OBJECT' || typeDetail.kind === 'INPUT_OBJECT') {
        output += `FIELDS:\\n`;
        if (fields.length > 0) {
          for (const field of fields) {
            output += `- \`${field.name}\`: \`${formatTypeForDisplay(field.type)}\`${field.description ? ` - ${field.description}` : ''}\\n`;

            let currentFieldType = field.type;
            // Unwrap NON_NULL and LIST to get to the core type
            while (currentFieldType.ofType && (currentFieldType.kind === 'NON_NULL' || currentFieldType.kind === 'LIST')) {
                currentFieldType = currentFieldType.ofType;
            }

            if (currentFieldType.kind === 'OBJECT') {
              const relatedTypeName = currentFieldType.name;
              if (relatedTypeName) {
                const isList = field.type.kind === 'LIST' || (field.type.kind === 'NON_NULL' && field.type.ofType?.kind === 'LIST');
                output += `  └── Relationship to: ${isList ? `[${relatedTypeName}]` : relatedTypeName}\\n`;
                output += `  └── Access via: ${typeName} { ${field.name} { ... } }\\n`;
              }
            } else if (currentFieldType.kind === 'ENUM') {
              const enumTypeName = currentFieldType.name;
              if (enumTypeName) {
                output += `  └── This field is an ENUM type: \`${enumTypeName}\`. Use \`find-fields(typeName: "${enumTypeName}")\` to see its values.\\n`;
              }
            }
          }
        } else {
          output += "No fields found for this type.\\n";
        }
        
        // Add common query patterns for specific types
        if (typeName === 'extraction') {
            output += `\\nCOMMON QUERY PATTERNS for extraction:\\n`;
            output += `  - Get recent extractions: order_by: { display_ts: desc }\\n`;
            output += `  - Filter by type (e.g., Issue, FeatureRequest - use bare enum value without quotes):\\n`;
            output += `    where: { types: { type: { name: { _eq: YourEnumValue } } } }\\n`;
            output += `  - Common enum values for filtering by type: Issue, FeatureRequest, Objection, PositiveFeedback, ActionItem, Question, Pricing\\n`;
            output += `  - Search summary/text: where: { summary: { _ilike: "%keyword%" } } (also works for 'text' field if available)\\n`;
        }
        if (typeName === 'interview') {
            output += `\\nCOMMON QUERY PATTERNS for interview:\\n`;
            output += `  - Get recent interviews: order_by: { display_ts: desc }\\n`;
            output += `  - Get specific interview by ID: query { interview_by_pk(id: "your_id_here") { ...fields... } } (note: uses primary key lookup, not 'where' clause for ID)\\n`;
            output += `  - Find interviews a person attended: see 'recent-conversation-with' tool or 'last-call-with-person' query template.\\n`;
        }
        if (typeName === 'person') {
            output += `\\nCOMMON QUERY PATTERNS for person:\\n`;
            output += `  - Find person by name: where: {_or: [{first_name: {_ilike: "%name%"}}, {last_name: {_ilike: "%name%"}}]} \\n`;
            output += `  - Filter by customer persona: where: { persona_id: {_eq: 246} } \\n`;
        }

      } else {
        output += `Details for kind ${typeDetail.kind} are not specially formatted by this tool.\\n`;
      }
      return { content: [{ type: "text", text: output.trim() }] };

    } catch (error: unknown) {
      return { content: [{ type: "text", text: `Error introspecting type '${typeName}': ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  } else if (toolName === "validate-query") {
    const query = args?.query as string;
    if (!query) {
      return { content: [{ type: "text", text: "Error: 'query' argument is required for validate-query." }], isError: true };
    }

    let syntaxValid = true;
    let syntaxErrorMessage = "";
    let isMutation = false;
    const potentialIssues: string[] = [];

    try {
      gql`${query}`; // Try to parse the query for syntax validation
    } catch (e: any) {
      syntaxValid = false;
      syntaxErrorMessage = e.message;
    }

    if (syntaxValid) {
      const lowerQuery = query.trim().toLowerCase();
      if (lowerQuery.startsWith("mutation") || lowerQuery.includes("mutation {")) {
        isMutation = true;
      }

      // Heuristic check for quoted enum values in common filter patterns
      const quotedEnumPattern = /(_eq|_neq|_in|_nin|_gt|_lt|_gte|_lte):\s*\"([A-Za-z_][A-Za-z0-9_]*)\"/g;
      let match;
      while ((match = quotedEnumPattern.exec(query)) !== null) {
        potentialIssues.push(
          `Potential quoted enum: Found \`\"${match[2]}\"\` after \`${match[1]}\`. ` +
          `Enum values in GraphQL are typically unquoted (e.g., \`${match[1]}: ${match[2]}\`). ` +
          `Use \`find-fields(typeName: "YourEnumTypeName")\` to see valid unquoted enum values.`
        );
      }
      
      // Heuristic for suspicious sub-selections on commonly scalar/enum fields
      const commonScalarLikeFields = ["id", "name", "summary", "text", "display_ts", "status", "type", "email", "title", "kind"];
      for (const scalarField of commonScalarLikeFields) {
        const subSelectionPattern = new RegExp(`\\b${scalarField}\\s*\\{`, 'g'); 
        if (subSelectionPattern.test(query)) {
          potentialIssues.push(
            `Potential invalid sub-selection on '${scalarField}'. Fields like '${scalarField}' are often scalar or enum types and cannot have sub-fields (e.g., { ... }). ` +
            `Verify with \`find-fields\` if '${scalarField}' on its parent type is an Object type. If it's a scalar/enum, remove the sub-selection.`
          );
        }
      }
    }

    let response = "## Query Validation Report ##\\n";
    response += `**Syntax Valid:** ${syntaxValid ? 'Yes' : `No - ${syntaxErrorMessage}`}\\n`;
    
    if (syntaxValid) {
      response += `**Is Mutation:** ${isMutation ? 'Yes (Mutations are BLOCKED)' : 'No'}\\n`;
      if (isMutation) {
         return { content: [{ type: "text", text: response + "\\n**Overall Result: INVALID (Mutations not allowed)**"}], isError: true };
      }
    }

    if (potentialIssues.length > 0) {
      response += "\\n**Potential Issues & Recommendations:**\\n";
      potentialIssues.forEach(issue => {
        response += `- ${issue}\\n`;
      });
    }

    if (syntaxValid && !isMutation && potentialIssues.length === 0) {
      response += "\\n**Overall Result: Query appears valid and is not a mutation. No common pitfalls detected by heuristics.**";
    } else if (syntaxValid && !isMutation) {
      response += "\\n**Overall Result: Query syntax is valid and not a mutation, but review potential issues above.**";
    }
    
    response += "\\n\\n**General Advice:**\\n";
    response += "- Always double-check field names, type names, and their casing.\\n";
    response += "- Use `find-fields(typeName: \"YourType\")` to get details about a type, its fields, and if it's an enum, its valid values.\\n";
    response += "- Consult the main guide for schema overview and query examples: `read-resource(uri: \"graphql://guide/context\")`.\\n";

    return { content: [{ type: "text", text: response }], isError: !syntaxValid || isMutation };
  } else if (toolName === "nl-query") { 
    const description = args?.description as string;
    if (!description) {
      return { content: [{ type: "text", text: "Error: 'description' argument is required for nl-query." }], isError: true };
    }

    const patterns = [
      { 
        regex: /(?:last call with|recent call with|most recent call with|latest call with|recent conversation with|most recent conversation with|latest conversation with|find the most recent call with|calls with|conversations with|meetings with|interviews with)\s+([\w\s.-]+)/i, 
        template: "recent-calls-with-person",
        extractParams: (match: RegExpMatchArray) => ({ name: match[1].trim() })
      },
      {
        regex: /(?:top|customer|recent)\s+issues/i,
        template: "signal-by-type", 
        extractParams: () => ({ type: "issue", personaId: 246, days: 30, limit: 10 }) 
      },
      {
        regex: /feature\s+requests/i,
        template: "signal-by-type", 
        extractParams: () => ({ type: "FeatureRequest", limit: 10, days: 30 }) 
      },
      { 
        regex: /(?:conversation|calls?|discussion|talk)\s+about\s+([\w\s.-]+)/i,
        template: "call-with-topic",
        extractParams: (match: RegExpMatchArray) => ({ topic: match[1].trim() })
      }
    ];
    
    let foundPattern = false;
    for (const pattern of patterns) {
      const match = description.match(pattern.regex);
      if (match) {
        foundPattern = true;
        const params = pattern.extractParams(match);
        const templateFn = queryTemplates[pattern.template]; // This is the QueryTemplate object
        if (!templateFn) {
          return { content: [{ type: "text", text: `Internal error: NL pattern references unknown template '${pattern.template}'.` }], isError: true };
        }
        const templateQuery = templateFn.generateQuery(params); // Use the generateQuery method
        let responseText = `Based on your description, I've generated this query using template '${pattern.template}':\\n`;
        responseText += `Description: ${templateFn.description}\\n`;
        
        responseText += "\\nParameters Inferred:\\n";
        if (Object.keys(params).length > 0) {
          templateFn.parameters.forEach(pInfo => {
            // Type assertion for params to allow string indexing
            if ((params as Record<string, any>)[pInfo.name] !== undefined) {
              responseText += `  - ${pInfo.name}: ${(params as Record<string, any>)[pInfo.name]} (Type: ${pInfo.type}${pInfo.description ? `, ${pInfo.description}`: ''})\\n`;
            }
          });
        } else {
          responseText += "  (No parameters inferred for the template from your description)\\n";
        }
        
        responseText += "\\nGenerated query:\\n```graphql\\n" + templateQuery + "\\n```";

        if (templateFn.getExampleVariables) {
          const exampleVars = templateFn.getExampleVariables(params);
          if (Object.keys(exampleVars).length > 0) {
             responseText += `\\n\\nRecommended GraphQL variables for this query:\\n\`\`\`json\\n${JSON.stringify(exampleVars, null, 2)}\\n\`\`\``;
          }
        }
        return { content: [{ type: "text", text: responseText }] };
      }
    }

    if (!foundPattern) { 
        try {
            const fallbackTopic = description; 
            const fallbackQueryParams = { topic: fallbackTopic, limit: 3 }; 
            const templateFn = queryTemplates["call-with-topic"];
            if (!templateFn) {
                 return { content: [{ type: "text", text: "Internal error: Fallback template 'call-with-topic' not found." }], isError: true };
            }
            const fallbackQuery = templateFn.generateQuery(fallbackQueryParams);
            let responseText = "I couldn't match your request to a specific pattern, so I'm trying a general topic search using the 'call-with-topic' template:\\n";
            responseText += `Description: ${templateFn.description}\\n`;
            responseText += `Parameters Used: topic='${fallbackTopic}', limit=3\\n`;
            responseText += "Generated query:\\n```graphql\\n" + fallbackQuery + "\\n```";
            
            if (templateFn.getExampleVariables) {
                const exampleVars = templateFn.getExampleVariables(fallbackQueryParams);
                 if (Object.keys(exampleVars).length > 0) {
                    responseText += `\\n\\nRecommended GraphQL variables for this query:\n\`\`\`json\\n${JSON.stringify(exampleVars, null, 2)}\n\`\`\``;
                 }
            }
            return {
                content: [ { type: "text", text: responseText } ]
            };
        } catch (e: any) {
            return { content: [{ type: "text", text: `Fallback topic search failed: ${e.message}. Please try rephrasing or use a more specific tool.` }], isError: true };
        }
    }
    return { content: [{ type: "text", text: "Could not process NL query."}], isError: true};

  } else if (toolName === "open-resource" || toolName === "read-resource") {
    const uri = args?.uri as string;
    if (!uri) {
      return { content: [{ type: "text", text: "Error: 'uri' argument is required for read-resource." }], isError: true };
    }
    return { content: [{ type: "resource", uri }] };
  } else if (toolName === "help") { 
    const topic = (args?.topic as string | undefined)?.toLowerCase();
    let helpText = "";
    if (!topic) {
      helpText = `# BuildBetter MCP Help

You can ask for help on specific topics.

**Core Capabilities:**
- **Query Data:** Use \`run-query\` for custom GraphQL, or tools like \`recent-conversation-with\`, \`top-customer-issues\`, \`topic-conversations\`.
- **Generate Queries:** Use \`query-template\` for predefined queries or \`nl-query\` for natural language requests.
- **Explore Schema:** Use \`list-types\`, \`find-fields\`, or \`read-resource(uri: "graphql://type/TypeName")\`. Also \`read-resource(uri: "graphql://diagram/schema-relationships")\` for a visual.
- **Read Documentation:** Use \`read-resource(uri: "graphql://guide/context")\` for the main guide.

**Available Help Topics:**
- \`help(topic: "queries")\`: Guidance on fetching data.
- \`help(topic: "schema")\`: How to understand the data structure.
- \`help(topic: "extractions")\`: Information about signals like issues, feedback.
- \`help(topic: "tools")\`: Overview of available tools.
- \`help(topic: "prompts")\`: Overview of guided prompt templates.

For detailed information, always refer to the main guide: \`read-resource(uri: "graphql://guide/context")\`.
`;
    } else {
      switch (topic) {
        case "queries":
          helpText = `# Help: Queries
- **Direct Execution:** Use \`run-query\` with your own GraphQL string and optional variables.
- **Template-based:** Use \`query-template\` with a template name (e.g., 'find-person', 'recent-calls', 'top-customer-issues') and parameters. Some templates produce queries that expect variables.
  Example: \`query-template(template: "recent-calls", parameters: { limit: 5 })\`
- **Natural Language:** Use \`nl-query\` with a description (e.g., "last call with Bob"). It handles simple patterns and falls back to a topic search.
- **Specific Data Tools:** For common tasks, use tools like \`recent-conversation-with\`, \`top-customer-issues\`, \`topic-conversations\`, \`search-extractions\`. These directly return data.
- **Validation:** Use \`validate-query\` before running complex custom queries.
See Section 3 and 5 of the main guide (\`graphql://guide/context\`) for more examples.`;
          break;
        case "schema":
          helpText = `# Help: Schema Exploration
- **List All Types:** Call \`list-types\` tool.
- **View Fields/Values of a Type:**
  - Use \`find-fields(typeName: "YourTypeName")\`. This works for Objects, Input Objects, and Enums (listing values).
  - Or, \`read-resource(uri: "graphql://type/YourTypeName")\` for a markdown description.
- **Understand Relationships:** 
  - The main guide (\`graphql://guide/context\`, Section 2) contains a schema overview.
  - For a visual, use \`read-resource(uri: "graphql://diagram/schema-relationships")\` or the \`schema-overview\` tool.
- **Dynamic Schema Resource:** \`read-resource(uri: "graphql://schema")\` lists all object types with descriptions.
- **Enum Values:** To list values of an enum (e.g., \`extraction_type_type_enum\`), use \`find-fields(typeName: "extraction_type_type_enum")\` or query \`{ __type(name:"extraction_type_type_enum"){ enumValues { name description } } }\` with \`run-query\`.`;
          break;
        case "extractions":
          helpText = `# Help: Extractions (Signals)
Extractions (often called signals) are key insights like issues, feature requests, etc.
- **Searching:** Use \`search-extractions(phrase: "keyword", type: "Issue")\`. Remember to use bare enum values for the 'type' (e.g., 'Issue', not '"Issue"').
- **Filtering by Type:** The \`search-extractions\` tool and various query templates (\`top-customer-issues\`, \`signal-by-type\`) support filtering by extraction type.
- **Common Types:** "Issue", "FeatureRequest", "Objection", "PositiveFeedback", "ActionItem". See Section 6 of the main guide (\`graphql://guide/context\`) for more.
- **Tools for Extractions:** \`top-customer-issues\`, \`search-extractions\`.
- **Prompts for Extractions:** \`call-extractions\`, \`recent-issues\`, \`feature-requests-by-date\`, etc., provide guided queries.`;
          break;
        case "tools":
          helpText = `# Help: Tools Overview
Tools perform direct actions or retrieve data. Key tools include:
- \`run-query\`: Execute GraphQL.
- \`list-types\`, \`find-fields\`: Schema exploration.
- \`search-extractions\`, \`recent-conversation-with\`, \`top-customer-issues\`, \`topic-conversations\`: Specific data retrieval.
- \`query-template\`, \`nl-query\`: Query generation assistance.
- \`read-resource\`: Access documentation and diagrams.
- \`validate-query\`: Check query validity.
Refer to Section 3 of the main guide (\`graphql://guide/context\`) for a full list with descriptions and examples.`;
          break;
        case "prompts":
          helpText = `# Help: Prompts Overview
Prompts provide guided instructions and example queries for common tasks. They don't return data directly but suggest a query for \`run-query\`.
Key prompts include:
- \`recent-calls\`, \`call-details\`, \`call-transcript\`: For call-related info.
- \`call-extractions\`, \`recent-issues\`, \`feature-requests-by-date\`: For extraction-related tasks.
- \`explore-schema\`: Guidance on schema discovery.
Refer to Section 4 of the main guide (\`graphql://guide/context\`) for a full list and how to use them.`;
          break;
        default:
          helpText = `No specific help available for topic '${topic}'. Try "queries", "schema", "extractions", "tools", or "prompts", or see the main guide: \`read-resource(uri: "graphql://guide/context")\`.`;
      }
    }
    return { content: [{ type: "text", text: helpText }] };
  }

  throw { code: -32601, message: "Method not found", data: { method: `tools/call/${toolName}` } };
});
// --- End Tool Handlers ---


// --- Prompt Handlers ---
const promptsList: Prompt[] = [
  {
    name: "recent-calls",
    description: "Guide: Generate a GraphQL query to list the most recent calls (interviews).",
    arguments: [
      { name: "limit", description: "Number of calls to return (default 10, max 50).", required: false }
    ]
  },
  {
    name: "call-details",
    description: "Guide: Retrieve detailed information about a specific call (interview) by ID.",
    arguments: [
      { name: "id", description: "The ID of the call (interview).", required: true }
    ]
  },
  {
    name: "call-transcript",
    description: "Guide: Retrieve the full transcript for a specific call (interview) by ID.",
    arguments: [
      { name: "id", description: "The ID of the call (interview).", required: true }
    ]
  },
  {
    name: "search-transcript",
    description: "Guide: Search within a call's transcript for a specific phrase.",
    arguments: [
      { name: "id", description: "The ID of the call (interview).", required: true },
      { name: "phrase", description: "Text to search for (case-insensitive).", required: true }
    ]
  },
  {
    name: "call-extractions",
    description: "Guide: Retrieve extractions (signals) from a call, optionally filtered by type name (e.g., 'Issue'). Use bare enum value for type.",
    arguments: [
      { name: "id", description: "The ID of the call (interview).", required: true },
      { name: "type", description: "Optional: Extraction type name (enum value, e.g., 'Issue', 'FeatureRequest').", required: false }
    ]
  },
  {
    name: "signal-frequency",
    description: "Guide: Show how many extractions exist for each extraction type across all calls.",
    arguments: []
  },
  {
    name: "feature-requests-by-date",
    description: "Guide: List 'FeatureRequest' extractions across calls in a date range.",
    arguments: [
      { name: "startDate", description: "Start date (YYYY-MM-DD).", required: true },
      { name: "endDate", description: "End date (YYYY-MM-DD).", required: true }
    ]
  },
  {
    name: "explore-schema",
    description: "Guide: Instructions on how to explore the GraphQL schema using available tools/resources.",
    arguments: []
  },
  {
    name: "recent-issues",
    description: "Guide: Query the most recent 'Issue'-type extractions (default limit 20, max 50).",
    arguments: [ { name: "limit", description: "Number of issues to return (default 20).", required: false } ]
  },
  {
    name: "feature-requests", 
    description: "Guide: Query the most recent 'FeatureRequest'-type extractions (default limit 20, max 50).",
    arguments: [ { name: "limit", description: "Number of feature requests to return (default 20).", required: false } ]
  },
  {
    name: "recent-objections",
    description: "Guide: List 'Objection'-type extractions in a date range (defaults to last 30 days, max 365 days).",
    arguments: [
      { name: "days", description: "Optional: Number of days back (default 30, max 365).", required: false },
      { name: "startDate", description: "Optional: Start date (YYYY-MM-DD). Overrides 'days'.", required: false },
      { name: "endDate", description: "Optional: End date (YYYY-MM-DD). Overrides 'days'.", required: false }
    ]
  },
  {
    name: "top-objections", 
    description: "Guide: Alias for recent-objections (past N days, default 30, max 365).",
    arguments: [
      { name: "days", description: "Days back (default 30, max 365).", required: false }
    ]
  },
  {
    name: "customer-objections",
    description: "Guide: Get 'Objection'-type extractions voiced by customers (persona filter) within a time range (default 30 days, max 365).",
    arguments: [
      { name: "days", description: "Days back (default 30, max 365).", required: false },
    ]
  },
  {
    name: "context-guide", 
    description: "Guide: Reminds to open the main BuildBetter Context Guide resource.",
    arguments: []
  },
];

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: promptsList };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const sendUserMessage = (text: string) => ({ messages: [{ role: "user", content: { type: "text", text } }] });
  const customerPersonaId = 246; 

  switch (name) {
    case "recent-calls": {
      const limit = Math.min(Math.max(1, parseInt(String(args.limit ?? 10), 10)), 50); // Guardrail
      const query = `query GetRecentCalls {\n  interview(order_by: {display_ts: desc}, limit: ${limit}) {\n    id\n    name\n    display_ts\n    recorded_at\n    short_summary \n    attendees(limit:3){person{first_name last_name}}\n  }\n}`;
      return sendUserMessage(`Use the \`run-query\` tool with the following GraphQL to list the ${limit} most recent calls (interviews):\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "call-details": {
      const id = args.id;
      if (!id) throw { code: -32602, message: "Missing required argument 'id' for call-details prompt." };
      const query = `query GetCallDetails {\n  interview_by_pk(id: "${id}") {\n    id\n    name\n    display_ts\n    recorded_at\n    short_summary\n    asset_duration_seconds\n    attendees {\n      person {\n        id\n        first_name\n        last_name\n        email\n        persona_id \n        company { name }\n      }\n    }\n  }\n}`; 
      return sendUserMessage(`Retrieve details for call (interview) **${id}** by running this query via \`run-query\`:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "call-transcript": {
      const id = args.id;
      if (!id) throw { code: -32602, message: "Missing required argument 'id' for call-transcript prompt." };
      const query = `query GetCallTranscript {\n  interview_by_pk(id: "${id}") {\n    id\n    name\n    display_ts\n    monologues(order_by: {start_sec: asc}) {\n      id\n      speaker \n      text\n      start_sec\n      end_sec\n      speaker_person { first_name last_name persona_id } \n    }\n  }\n}`;
      return sendUserMessage(`Fetch the full transcript for call (interview) **${id}** with:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "search-transcript": {
      const id = args.id;
      const phrase = args.phrase;
      if (!id || !phrase) throw { code: -32602, message: "Arguments 'id' and 'phrase' are required for search-transcript prompt." };
      const query = `query SearchTranscriptContent {\n  interview_monologue(\n    where: {\n      text: {_ilike: "%${normalizeEnumValue(phrase as string)}%"},\n      interview_id: {_eq: "${id}"}\n    },\n    order_by: {start_sec: asc}\n  ) {\n    id\n    start_sec\n    end_sec\n    text\n    speaker_person { first_name, last_name } \n    interview { id name }\n  }\n}`;
      return sendUserMessage(`Search for "**${phrase}**" in the transcript of call (interview) **${id}** using:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "call-extractions": {
      const id = args.id;
      if (!id) throw { code: -32602, message: "Missing required argument 'id' for call-extractions prompt." };
      const typeName = args.type ? normalizeEnumValue(args.type as string) : undefined;
      let whereClause = `call_id: {_eq: "${id}"}`; 
      if (typeName) {
        whereClause += `, types: { type: { name: {_eq: ${typeName}} } }`; // Bare enum
      }
      const query = `query GetCallExtractions {\n  extraction(\n    where: { ${whereClause} }\n    order_by: {display_ts: asc}\n  ) {\n    id\n    summary \n    display_ts \n    sentiment\n    types { type { name } } \n    speaker { person { first_name last_name persona_id } } \n  }\n}`;
      const desc = typeName ? `type **${typeName}**` : 'all types';
      return sendUserMessage(`Retrieve ${desc} extractions for call (interview) **${id}** with:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "signal-frequency": { 
      const query = `query GetExtractionTypeFrequency {\n  extraction_type {\n    id\n    name\n    extraction_type_joins_aggregate { \n       aggregate { count }\n    }\n  }\n}`;
      return sendUserMessage(`Run this query to see extraction (signal) counts per type across all calls:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "feature-requests-by-date": {
      const startDate = args.startDate as string;
      const endDate = args.endDate as string;
      if (!startDate || !endDate) throw { code: -32602, message: "Arguments 'startDate' and 'endDate' are required for feature-requests-by-date prompt." };
      const featureRequestType = normalizeEnumValue("FeatureRequest");
      const query = `query FeatureRequestsByDate {\n  extraction(\n    where: {\n      types: { type: { name: {_eq: ${featureRequestType}} } }, \n      display_ts: { _gte: "${startDate}T00:00:00Z", _lte: "${endDate}T23:59:59Z" } \n    },\n    order_by: { display_ts: desc }\n  ) {\n    id\n    summary\n    display_ts\n    call { id name display_ts }\n  }\n}`;
      return sendUserMessage(`Get 'FeatureRequest' extractions between **${startDate}** and **${endDate}** using:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "explore-schema": {
      const text = `To explore the GraphQL schema:
1.  **List All Object Types:** Use the \`list-types\` tool.
2.  **View Fields/Values of a Specific Type:**
    -   Use \`find-fields(typeName: "YourTypeName")\`. This works for Objects, Input Objects, and Enums.
    -   Or, use \`read-resource(uri: "graphql://type/YourTypeName")\` for a markdown description.
3.  **Understand Relationships:** Consult Section 2 of the main guide (\`read-resource(uri: "graphql://guide/context")\`) or use \`read-resource(uri: "graphql://diagram/schema-relationships")\`.
4.  **Build Basic Queries:** Use the \`build-query\` tool (note: no nested fields).`;
      return sendUserMessage(text);
    }
    case "recent-issues": {
      const limit = Math.min(Math.max(1, parseInt(String(args.limit ?? 20), 10)), 50);
      const issueType = normalizeEnumValue("Issue");
      const query = `query RecentIssues {\n  extraction(\n    where: { types: { type: { name: {_eq: ${issueType}} } } }, \n    order_by: { display_ts: desc }, \n    limit: ${limit}\n  ) {\n    id\n    summary\n    display_ts\n    call { id name display_ts }\n  }\n}`;
      return sendUserMessage(`Use \`run-query\` with the following GraphQL to get the ${limit} most recent 'Issue' extractions:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "feature-requests": {
      const limit = Math.min(Math.max(1, parseInt(String(args.limit ?? 20), 10)), 50);
      const featureRequestType = normalizeEnumValue("FeatureRequest");
      const query = `query RecentFeatureRequests {\n  extraction(\n    where: { types: { type: { name: {_eq: ${featureRequestType}} } } }, \n    order_by: { display_ts: desc }, \n    limit: ${limit}\n  ) {\n    id\n    summary\n    display_ts\n    call { id name display_ts }\n  }\n}`;
      return sendUserMessage(`Use \`run-query\` with the following GraphQL to get the ${limit} most recent 'FeatureRequest' extractions:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "recent-objections": { 
      let daysVal = 30; 
      if (args.days !== undefined) {
          const parsed = parseInt(String(args.days), 10);
          if (!isNaN(parsed) && parsed > 0) {
              daysVal = Math.min(parsed, 365); 
          }
      }
      let startDate = args.startDate as string | undefined;
      let endDate = args.endDate as string | undefined;

      if (!startDate || !endDate) { 
        const baseDate = new Date();
        endDate = baseDate.toISOString().split('T')[0];
        baseDate.setDate(baseDate.getDate() - daysVal);
        startDate = baseDate.toISOString().split('T')[0];
      }
      
      const objectionType = normalizeEnumValue("Objection");
      const query = `query RecentObjections {\n  extraction(\n    where: {\n      types: { type: { name: {_eq: ${objectionType}} } }, \n      display_ts: { _gte: "${startDate}T00:00:00Z", _lte: "${endDate}T23:59:59Z" }\n    },\n    order_by: { display_ts: desc }\n  ) {\n    id\n    summary\n    display_ts\n    call { id name }\n  }\n}`;
      return sendUserMessage(`Run this query to get 'Objection' type extractions from **${startDate}** to **${endDate}**:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "context-guide": {
      const text = `Open the main BuildBetter Context Guide with the \`read-resource\` tool:\n\n\`\`\`json\n{\n  "name": "read-resource",\n  "arguments": { "uri": "graphql://guide/context" }\n}\n\`\`\``;
      return sendUserMessage(text);
    }
    case "top-objections": { 
      let daysVal = 30;
      if (args.days !== undefined) {
          const parsed = parseInt(String(args.days), 10);
          if (!isNaN(parsed) && parsed > 0) {
              daysVal = Math.min(parsed, 365);
          }
      }
      const endDate = new Date().toISOString().slice(0,10);
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - daysVal);
      const startDate = sinceDate.toISOString().slice(0,10);
      
      const objectionType = normalizeEnumValue("Objection");
      const query = `query TopObjections {\n  extraction(\n    where: {\n      types: { type: { name: {_eq: ${objectionType}} } }, \n      display_ts: { _gte: "${startDate}T00:00:00Z", _lte: "${endDate}T23:59:59Z" }\n    },\n    order_by: { display_ts: desc }\n  ) {\n    id\n    summary\n    display_ts\n    call { id name }\n  }\n}`;
      return sendUserMessage(`To get top objections from the last ${daysVal} days (from **${startDate}** to **${endDate}**), run this query:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    case "customer-objections": {
      let daysVal = 30;
      if (args.days !== undefined) {
          const parsed = parseInt(String(args.days), 10);
          if (!isNaN(parsed) && parsed > 0) {
              daysVal = Math.min(parsed, 365);
          }
      }
      const endDate = new Date().toISOString().slice(0,10);
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - daysVal);
      const startDate = sinceDate.toISOString().slice(0,10);
      const objectionType = normalizeEnumValue("Objection");

      const query = `query CustomerObjections {\n  extraction(\n    where: {\n      types: { type: { name: {_eq: ${objectionType}} } },\n      speaker: { person: { persona_id: {_eq: ${customerPersonaId}} } }, \n      display_ts: { _gte: "${startDate}T00:00:00Z", _lte: "${endDate}T23:59:59Z" }\n    },\n    order_by: { display_ts: desc },\n    limit: 20 
  ) {\n    id\n    summary\n    display_ts\n    sentiment\n    call { id name }\n  }\n}`;
      return sendUserMessage(`To get objections voiced by customers in the last ${daysVal} days (from **${startDate}** to **${endDate}**), use the \`run-query\` tool with this GraphQL:\n\n\`\`\`graphql\n${query}\n\`\`\``);
    }
    default:
      throw { code: -32601, message: `Prompt named '${name}' not found.`, data: { name } };
  }
});
// --- End Prompt Handlers ---


// --- Main Execution ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport); // Corrected: Removed second argument
  try {
    await server.notification({
      method: "chat/message",
      params: {
        role: "system",
        content: { type: "text", text: "BuildBetter MCP Server Connected. Before querying, it's recommended to open the context guide: `read-resource(uri: \"graphql://guide/context\")`." }
      }
    });
  } catch {
    /* ignore if transport doesn't support notifications */
  }
  console.error("BuildBetter GraphQL MCP Server started successfully via stdio. Version 0.0.2");
}

main().catch(error => {
  console.error("Error starting server:", error instanceof Error ? error.message : error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as any).code : -32000;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Exiting with code ${code}: ${message}`);
  process.exit(1); 
});