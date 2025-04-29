export enum MessageTypeEnum {
  Text = 'text',
  Photo = 'photo',
  Video = 'video',
  Call = 'call',
  Payment = 'payment',
  Rate = 'rate',
  RecommendDoctor = 'recommendDoctor',
  AcceptOperator = 'acceptOperator',
  Document = 'document',
}

export enum ConsultationStatus {
  NEW = 0,
  IN_PROGRESS = 1,
  FINISHED = 2,
}

export enum ConsultationTransactionStatus {
  NOT_PAYED = 0,
  PAYED = 1,
}
