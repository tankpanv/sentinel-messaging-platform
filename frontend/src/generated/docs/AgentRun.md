
# AgentRun


## Properties

Name | Type
------------ | -------------
`id` | string
`groupId` | string
`status` | string
`endReason` | string
`summary` | string
`steps` | [Array&lt;AgentStep&gt;](AgentStep.md)
`traceId` | string
`createdAt` | string

## Example

```typescript
import type { AgentRun } from ''

// TODO: Update the object below with actual values
const example = {
  "id": null,
  "groupId": null,
  "status": null,
  "endReason": null,
  "summary": null,
  "steps": null,
  "traceId": null,
  "createdAt": null,
} satisfies AgentRun

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as AgentRun
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


