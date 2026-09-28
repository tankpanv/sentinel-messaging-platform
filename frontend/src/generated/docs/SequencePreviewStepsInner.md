
# SequencePreviewStepsInner


## Properties

Name | Type
------------ | -------------
`index` | number
`accountRole` | string
`senderAccountId` | string
`text` | string
`delaySeconds` | number
`resolvedVars` | { [key: string]: string; }
`varSources` | { [key: string]: string; }

## Example

```typescript
import type { SequencePreviewStepsInner } from ''

// TODO: Update the object below with actual values
const example = {
  "index": null,
  "accountRole": null,
  "senderAccountId": null,
  "text": null,
  "delaySeconds": null,
  "resolvedVars": null,
  "varSources": null,
} satisfies SequencePreviewStepsInner

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as SequencePreviewStepsInner
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


