
# SequenceRunStep


## Properties

Name | Type
------------ | -------------
`index` | number
`status` | string
`text` | string
`accountRole` | string
`senderAccountId` | string
`accountId` | string
`scheduledAt` | string
`sentAt` | string
`clientMsgId` | string
`resolvedVars` | { [key: string]: string; }
`varSources` | { [key: string]: string; }

## Example

```typescript
import type { SequenceRunStep } from ''

// TODO: Update the object below with actual values
const example = {
  "index": null,
  "status": null,
  "text": null,
  "accountRole": null,
  "senderAccountId": null,
  "accountId": null,
  "scheduledAt": null,
  "sentAt": null,
  "clientMsgId": null,
  "resolvedVars": null,
  "varSources": null,
} satisfies SequenceRunStep

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as SequenceRunStep
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


