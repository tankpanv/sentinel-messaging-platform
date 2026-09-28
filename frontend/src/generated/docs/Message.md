
# Message


## Properties

Name | Type
------------ | -------------
`id` | string
`msgId` | string
`clientMsgId` | string
`senderPlatformUserId` | string
`isOwn` | boolean
`text` | string
`sentAt` | string
`deliveryStatus` | string
`failCode` | string
`localFilePath` | string
`media` | [MessageMedia](MessageMedia.md)

## Example

```typescript
import type { Message } from ''

// TODO: Update the object below with actual values
const example = {
  "id": null,
  "msgId": null,
  "clientMsgId": null,
  "senderPlatformUserId": null,
  "isOwn": null,
  "text": null,
  "sentAt": null,
  "deliveryStatus": null,
  "failCode": null,
  "localFilePath": null,
  "media": null,
} satisfies Message

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as Message
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


