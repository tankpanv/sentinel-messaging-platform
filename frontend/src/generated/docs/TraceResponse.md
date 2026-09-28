
# TraceResponse


## Properties

Name | Type
------------ | -------------
`traceId` | string
`events` | [Array&lt;TraceEvent&gt;](TraceEvent.md)
`truncated` | boolean

## Example

```typescript
import type { TraceResponse } from ''

// TODO: Update the object below with actual values
const example = {
  "traceId": null,
  "events": null,
  "truncated": null,
} satisfies TraceResponse

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as TraceResponse
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


