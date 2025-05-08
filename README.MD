# BuildBetter MCP (Model-Context-Protocol) Server

This repository contains **BuildBetter's official MCP adapter**.  It bridges the BuildBetter API ↔ LLMs (Claude, ChatGPT, etc.) allowing them to run safe, read-only queries and receive rich context.

## 🚀 Open Beta: Request Access!

This adapter is currently in a **Request-Access Open Beta**. To get started:

- **Email us at `support@buildbetter.app` to request your API key.**
- This feature is **free on all plans** while in beta.
- It can be used with **any MCP client** that supports custom servers.

It is purpose-built to:

- Connect to the BuildBetter's API endpoint
- Expose BuildBetter's schema as browsable resources
- Provide tools for running *read-only* BuildBetter queries (mutations are blocked)
- Query for relevent data for BuildBetter data

## Features

### Resources

- **Schema List**: View all available types in your BuildBetter schema
- **Type Details**: Explore fields and structure of specific types

### Tools

- **run-query** – Execute read-only GraphQL (mutations are blocked)
- **list-types** – List all OBJECT types (mutation types are hidden)
- **build-query** – Generate a skeleton query for a type + fields
- **find-fields** – Introspect fields for a given type
- **search-extractions** – Keyword search with optional `type` and `personaIds` filters
- **open-resource / read-resource** – Fetch static docs exposed as resources
- **schema-overview** – Mermaid diagram of core relationships

### Prompts

The server ships a library of ready-made prompt templates (see **index.ts**) such as:

- **recent-calls** – latest interviews
- **call-details / call-transcript**
- **search-transcript** – phrase search inside a call
- **recent-issues / feature-requests**
- **top-customer-issues**
- **recent-objections / top-objections / customer-objections**
- **feature-requests-by-date**
- **signal-frequency** – aggregation per extraction_type
- **context-guide** – instructs the model to open the Markdown guide first

You can discover them with the `prompts/list` MCP request.

## Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create an `.env` file (or set env vars in your shell) with:
   ```env
   # BuildBetter staging / prod GraphQL endpoint
   BUILDBETTER_ENDPOINT="https://api.buildbetter.app/v1/graphql"
   # Personal API key – generate from BuildBetter dashboard
   BUILDBETTER_API_KEY="YOUR_API_KEY_HERE"
   ```
4. Build the server (compiles TypeScript ➜ ./build):
   ```bash
   npm run build
   ```

## Usage

### Starting the Server

Run the server:

```
npm start
```

### Connecting with Claude for Desktop

Add the server to your Claude for Desktop configuration by editing your `claude_desktop_config.json` file:

```json
{
  "mcpServers": {
     "BuildBetter-MCP": {
      "command": "node",
      "args": ["../BuildBetter-MCP/build/index.js"],
      "cwd": "../BuildBetter-MCP",
      "env": {
        "BUILDBETTER_ENDPOINT": "https://api.buildbetter.app/v1/graphql",
        "BUILDBETTER_API_KEY": "ENTER_KEY_HERE"
      }
    }
}
```

## Security & Privacy

- **Read-only** – all mutation attempts are blocked at runtime.
- **Persona filtering** – helper arguments (`personaIds`) allow you to restrict queries to Customer-only data.
- **Input validation** – every tool verifies arguments before execution.
- **Schema minimisation** – mutation types are hidden from `list-types` and docs.

## Development

For development, you can use:

```
npm run dev
```

## License

All Rights Reserved