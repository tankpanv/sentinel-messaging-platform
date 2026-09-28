
# SequenceRun


## Properties

Name | Type
------------ | -------------
`id` | string
`groupId` | string
`sequenceId` | string
`status` | string
`currentStepIndex` | number
`steps` | [Array&lt;SequenceRunStep&gt;](SequenceRunStep.md)
`createdAt` | string

## Example

```typescript
import type { SequenceRun } from ''

// TODO: Update the object below with actual values
const example = {
  "id": null,
  "groupId": null,
  "sequenceId": null,
  "status": null,
  "currentStepIndex": null,
  "steps": null,
  "createdAt": null,
} satisfies SequenceRun

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as SequenceRun
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


