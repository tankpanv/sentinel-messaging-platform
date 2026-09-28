
# GatewayGroupMember


## Properties

Name | Type
------------ | -------------
`id` | string
`accountId` | string
`platformUserId` | string
`displayName` | string
`role` | string
`managed` | boolean
`status` | string

## Example

```typescript
import type { GatewayGroupMember } from ''

// TODO: Update the object below with actual values
const example = {
  "id": null,
  "accountId": null,
  "platformUserId": null,
  "displayName": null,
  "role": null,
  "managed": null,
  "status": null,
} satisfies GatewayGroupMember

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as GatewayGroupMember
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


