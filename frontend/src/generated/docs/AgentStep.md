
# AgentStep


## Properties

Name | Type
------------ | -------------
`kind` | string
`toolUseId` | string
`name` | string
`input` | object
`resultSummary` | string
`isError` | boolean
`errorCode` | string
`auditVerdict` | string
`rawResponse` | string

## Example

```typescript
import type { AgentStep } from ''

// TODO: Update the object below with actual values
const example = {
  "kind": null,
  "toolUseId": null,
  "name": null,
  "input": null,
  "resultSummary": null,
  "isError": null,
  "errorCode": null,
  "auditVerdict": null,
  "rawResponse": null,
} satisfies AgentStep

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as AgentStep
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


