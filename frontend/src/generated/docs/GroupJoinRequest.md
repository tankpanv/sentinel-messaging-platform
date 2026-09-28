
# GroupJoinRequest


## Properties

Name | Type
------------ | -------------
`id` | string
`groupId` | string
`accountId` | string
`status` | string
`errorCode` | string
`requestedAt` | string
`decidedAt` | string

## Example

```typescript
import type { GroupJoinRequest } from ''

// TODO: Update the object below with actual values
const example = {
  "id": null,
  "groupId": null,
  "accountId": null,
  "status": null,
  "errorCode": null,
  "requestedAt": null,
  "decidedAt": null,
} satisfies GroupJoinRequest

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as GroupJoinRequest
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


